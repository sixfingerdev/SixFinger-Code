import { LayerNode } from "@sixfinger/core/effect/layer-node"
import { SessionV1 } from "@sixfinger/core/v1/session"
import { ConfigV1 } from "@sixfinger/core/v1/config/config"
import { Database } from "@sixfinger/core/database/database"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Cause, Effect, Layer, Context, DateTime, Option } from "effect"
import { FSUtil } from "@sixfinger/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@sixfinger/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@sixfinger/core/provider"
import { ModelV2 } from "@sixfinger/core/model"
import { buildPrompt } from "@sixfinger/core/session/compaction"
import { SessionCompactionEvent } from "@sixfinger/schema/session-compaction-event"
import { SessionEvent } from "@sixfinger/schema/session-event"
import { SessionMessage } from "@sixfinger/schema/session-message"
import { MemoryStore } from "./memory-store"
import * as Bom from "@/util/bom"

export const Event = SessionCompactionEvent

// After compaction, the most recently read files are re-injected so the model
// does not have to re-read them (CC parity: file restore).
const RESTORE_MAX_FILES = 5
const RESTORE_TOKEN_BUDGET = 50_000

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 8_000
const MAX_PRESERVE_RECENT_TOKENS = 40_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID; idle?: boolean }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    from?: MessageID
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
    from?: MessageID
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@sixfinger/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const fsys = yield* FSUtil.Service
    const database = yield* Database.Service

    // Circuit breaker: after BREAKER_LIMIT consecutive failed auto-compactions
    // on the same session, stop retrying them. Each failure is pointless (the
    // same oversized/erroring request would be re-sent), and unbounded retries
    // have historically burned large amounts of API spend.
    const breaker = {
      failures: new Map<string, number>(),
      disabled: new Map<string, string>(),
    }
    const BREAKER_LIMIT = 3

    const recordFailure = Effect.fn("SessionCompaction.recordFailure")(function* (input: {
      sessionID: SessionID
      userMessageID: MessageID
      error: string
    }) {
      const count = (breaker.failures.get(input.sessionID) ?? 0) + 1
      breaker.failures.set(input.sessionID, count)
      if (count < BREAKER_LIMIT) return
      breaker.disabled.set(input.sessionID, input.error)
      yield* session
        .updatePart({
          id: PartID.ascending(),
          messageID: input.userMessageID,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: `Auto-compact failed ${count} times in a row, so it is now disabled for this session (last error: ${input.error}). Run /compact manually to try again.`,
          time: { start: Date.now() },
        })
        .pipe(Effect.ignore)
    })

    // Re-inject the most recently read files after a compaction so the model
    // continues working without re-reading them (CC parity: file restore).
    const restoreFiles = Effect.fn("SessionCompaction.restoreFiles")(function* (input: {
      sessionID: SessionID
      parentID: MessageID
      history: SessionV1.WithParts[]
    }) {
      const filePaths: string[] = []
      for (const msg of [...input.history].reverse()) {
        for (const part of [...msg.parts].reverse()) {
          if (part.type !== "tool") continue
          if (part.tool !== "read" && part.tool !== "bash") continue
          if (part.state.status !== "completed") continue
          const path = typeof part.state.input?.filePath === "string" ? part.state.input.filePath : undefined
          if (!path || filePaths.includes(path)) continue
          filePaths.push(path)
          if (filePaths.length >= RESTORE_MAX_FILES) break
        }
        if (filePaths.length >= RESTORE_MAX_FILES) break
      }
      if (filePaths.length === 0) return

      let budget = RESTORE_TOKEN_BUDGET
      const restored: string[] = []
      for (const filePath of filePaths) {
        if (budget <= 0) break
        const source = yield* Bom.readFile(fsys, filePath).pipe(Effect.option)
        if (Option.isNone(source)) continue
        const content = source.value.text
        if (!content.trim()) continue
        const estimate = Token.estimate(content)
        if (estimate > budget) {
          const sliced = content.slice(0, Math.max(0, budget * 4))
          restored.push(`<file path="${filePath}" truncated="true">\n${sliced}\n</file>`)
          budget = 0
          continue
        }
        restored.push(`<file path="${filePath}">\n${content}\n</file>`)
        budget -= estimate
      }
      if (restored.length === 0) return

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: input.parentID,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: [
          "The following files were read before compaction and are restored here so you can continue working without re-reading them:",
          ...restored,
        ].join("\n\n"),
        time: { start: Date.now() },
      })
      yield* Effect.logInfo("restored files after compaction", { count: restored.length, sessionID: input.sessionID })
    })

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)
      const last = recent.at(-1)!

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      // Guarantee a verbatim tail: token estimates undercount (e.g. media
      // attachments), so a walk that keeps everything - or nothing - must not
      // leave the model with summary-only context. Always retain at least the
      // newest turn's suffix; the head still gets summarized.
      if (!keep || keep.start <= 0) {
        const split = yield* splitTurn({
          messages: input.messages,
          turn: last,
          model: input.model,
          budget,
          estimate,
        })
        if (split && split.start > 0) keep = split
        else if (all.length > 1) keep = { start: last.start, id: last.id }
        yield* Effect.logInfo("tail guarantee", { start: keep?.start, budget })
      }

      // Degenerate single-turn session: keep the newest message as tail so the
      // summary still covers the full head.
      if (!keep || keep.start <= 0) {
        return { head: input.messages, tail_start_id: input.messages.at(-1)!.info.id }
      }

      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: {
      sessionID: SessionID
      /** Aggressive pass when the prompt cache is already cold after an idle
       * gap: the protect budget halves because keeping old output buys nothing. */
      idle?: boolean
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning", { idle: input.idle === true })

      const protect = input.idle ? Math.floor(PRUNE_PROTECT / 2) : PRUNE_PROTECT
      const minimum = input.idle ? Math.floor(PRUNE_MINIMUM / 2) : PRUNE_MINIMUM

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= protect) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > minimum) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      /** Partial compact (manual): everything BEFORE this message gets
       * summarized; the message itself and everything after stays verbatim. */
      from?: MessageID
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      const cfg = yield* config.get()

      // Memory mode: no model call. The working context becomes the persistent
      // memories plus the newest turns; everything older simply drops.
      if (cfg.compaction?.mode === "memory") {
        const memories = yield* MemoryStore.list({ fsys, sessionID: input.sessionID })
        const memoryLines = memories.map((memory) => `- ${memory.content}`)
        const keepId = input.messages.at(-1)?.info.id ?? input.parentID
        if (compactionPart) {
          yield* session.updatePart({
            ...compactionPart,
            tail_start_id: keepId,
          })
        }
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: input.parentID,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: [
            "<context_compacted>",
            "The conversation history before the most recent turns was removed without a model call.",
            ...(memoryLines.length
              ? ["Persistent memories in effect:", ...memoryLines]
              : ['No persistent memories stored yet. Use the memory tool to record durable facts.']),
            "",
            "The messages after the compaction point follow below.",
            "</context_compacted>",
          ].join("\n"),
          time: { start: Date.now() },
        })
        return "continue"
      }

      if (input.auto) {
        const disabled = breaker.disabled.get(input.sessionID)
        if (disabled) {
          yield* Effect.logWarning("auto-compact skipped: circuit breaker open", {
            sessionID: input.sessionID,
            lastError: disabled,
          })
          return "stop"
        }
      }

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      // Partial compact: only summarize the history before the chosen message;
      // everything from that message on stays verbatim in the working context.
      if (input.from) {
        let idx = messages.findIndex((m) => m.info.id === input.from)
        if (idx < 0) {
          // The working history is trimmed by filterCompacted, so after an
          // earlier completed compaction the target can fall outside it.
          // Reload the full stream before giving up.
          const full = yield* MessageV2.stream(input.sessionID).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          idx = full.findIndex((m) => m.info.id === input.from)
          if (idx > 0) messages = full
        }
        if (idx <= 0) {
          // Target is the first message (nothing before it) or is gone from the
          // store entirely. Fall back to a full compact of the working history
          // instead of failing — a failed partial compact would otherwise retry
          // and throw on every subsequent prompt because the compaction part
          // persists in the task queue.
          yield* Effect.logWarning("partial compact target missing, falling back to full compact", {
            sessionID: input.sessionID,
            from: input.from,
          })
        } else {
          messages = messages.slice(0, idx)
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      yield* events
        .publish(SessionEvent.Compaction.Started, {
          sessionID: SessionID.make(input.sessionID),
          messageID: SessionMessage.ID.make(msg.id),
          timestamp: yield* DateTime.now,
          reason: input.auto ? ("auto" as const) : ("manual" as const),
        })
        .pipe(Effect.ignore)

      // The Ended event clears the compacting state on every exit path,
      // including processor failure, so the TUI indicator never sticks.
      let summary = ""
      const result = yield* Effect.gen(function* () {
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    nextPrompt,
                    ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                },
              ],
            },
          ],
          model,
        })
        if (result === "compact") {
          processor.message.error = new SessionV1.ContextOverflowError({
            message: replay
              ? "Conversation history too large to compact - exceeds model context limit"
              : "Session too large to compact - context exceeds model limit even after stripping media",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          if (input.auto) {
            yield* recordFailure({
              sessionID: input.sessionID,
              userMessageID: userMessage.id,
              error: "conversation too large to compact",
            }).pipe(Effect.ignore)
          }
          return "stop"
        }

        // Partial compact: the tail restarts at the chosen message; full
        // compact keeps the auto-selected verbatim tail.
        const tailStartId = input.from ?? selected.tail_start_id
        if (compactionPart && tailStartId && compactionPart.tail_start_id !== tailStartId) {
          yield* session.updatePart({
            ...compactionPart,
            tail_start_id: tailStartId,
          })
        }

        if (result === "continue" && input.auto) {
          if (replay) {
            const original = replay.info
            const replayMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: original.agent,
              model: original.model,
              format: original.format,
              tools: original.tools,
              system: original.system,
            })
            for (const part of replay.parts) {
              if (part.type === "compaction") continue
              const replayPart =
                part.type === "file" && MessageV2.isMedia(part.mime)
                  ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                  : part
              yield* session.updatePart({
                ...replayPart,
                id: PartID.ascending(),
                messageID: replayMsg.id,
                sessionID: input.sessionID,
              })
            }
          }

          if (!replay) {
            const info = yield* provider.getProvider(userMessage.model.providerID)
            if (
              (yield* plugin.trigger(
                "experimental.compaction.autocontinue",
                {
                  sessionID: input.sessionID,
                  agent: userMessage.agent,
                  model: yield* provider
                    .getModel(userMessage.model.providerID, userMessage.model.modelID)
                    .pipe(Effect.orDie),
                  provider: {
                    source: info.source,
                    info,
                    options: info.options,
                  },
                  message: userMessage,
                  overflow: input.overflow === true,
                },
                { enabled: true },
              )).enabled
            ) {
              const continueMsg = yield* session.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: input.sessionID,
                time: { created: Date.now() },
                agent: userMessage.agent,
                model: userMessage.model,
              })
              const text =
                (input.overflow
                  ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                  : "") +
                "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: continueMsg.id,
                sessionID: input.sessionID,
                type: "text",
                // Internal marker for auto-compaction followups so provider plugins
                // can distinguish them from manual post-compaction user prompts.
                // This is not a stable plugin contract and may change or disappear.
                metadata: { compaction_continue: true },
                synthetic: true,
                text,
                time: {
                  start: Date.now(),
                  end: Date.now(),
                },
              })
            }
          }
        }

        const written = yield* session.messages({ sessionID: input.sessionID, limit: 50 }).pipe(
          Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])),
        )
        summary = (written.find((item) => item.info.id === msg.id)?.parts ?? [])
          .filter((part): part is SessionV1.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        if (result === "continue") {
          breaker.failures.delete(input.sessionID)
          yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
          // Restore the most recently read files so the model continues where
          // it left off instead of re-reading them one by one.
          yield* restoreFiles({
            sessionID: input.sessionID,
            parentID: input.parentID,
            history,
          }).pipe(Effect.ignore)
        }
        return result
      }).pipe(
        // Record failed auto-compactions for the circuit breaker, then re-raise
        // so the caller sees the original failure.
        Effect.catchCause((cause) => {
          if (!input.auto) return Effect.failCause(cause)
          const error = Cause.squash(cause)
          const message = error instanceof Error ? error.message : String(error)
          return Effect.gen(function* () {
            yield* recordFailure({
              sessionID: input.sessionID,
              userMessageID: userMessage.id,
              error: message,
            }).pipe(Effect.ignore)
            return yield* Effect.failCause(cause)
          })
        }),
        // Effect.ensuring's finalizer argument is built eagerly, so the payload
        // must be constructed lazily — otherwise `text` captures the still-empty
        // `summary` from before the summary generation ran.
        Effect.ensuring(
          Effect.suspend(() =>
            events
              .publish(SessionEvent.Compaction.Ended, {
                sessionID: SessionID.make(input.sessionID),
                messageID: SessionMessage.ID.make(msg.id),
                timestamp: DateTime.makeUnsafe(Date.now()),
                reason: input.auto ? ("auto" as const) : ("manual" as const),
                text: summary,
                recent: "",
              })
              .pipe(Effect.ignore),
          ),
        ),
      )
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      from?: MessageID
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        from: input.from,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    FSUtil.node,
    Database.node,
  ],
})

export * as SessionCompaction from "./compaction"

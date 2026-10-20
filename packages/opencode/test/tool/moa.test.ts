import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { MoaTool } from "../../src/tool/moa"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())

const seed = Effect.fn("MoaToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function stubOps(handler: (input: SessionPrompt.PromptInput) => string): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.sync(() => reply(input, handler(input))),
  }
}

function ctxOf(chat: { id: SessionID }, assistant: { id: MessageID }, promptOps: TaskPromptOps) {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.moa", () => {
  it.instance("fans out to proposers and synthesizes with the default aggregator", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* MoaTool
      const def = yield* tool.init()
      const seen: SessionPrompt.PromptInput[] = []
      const promptOps = stubOps((input) => {
        seen.push(input)
        if (input.agent === "coder") return "coder proposal"
        if (input.agent === "reviewer") return "reviewer proposal"
        return "synthesized answer"
      })

      const result = yield* def.execute(
        {
          description: "design cache",
          prompt: "design a cache layer",
          proposers: ["coder", "reviewer"],
        },
        ctxOf(chat, assistant, promptOps),
      )

      expect(result.output).toContain("<synthesis>\nsynthesized answer\n</synthesis>")
      expect(result.output).toContain('agent="coder"')
      expect(result.output).toContain("coder proposal")
      expect(result.output).toContain('agent="reviewer"')
      expect(result.metadata.proposers).toEqual(["coder", "reviewer"])
      expect(result.metadata.aggregator).toBe("general")
      expect(result.metadata.rounds).toBe(1)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(3)
      const seenAgents = seen.map((input) => input.agent).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))
      expect(seenAgents).toEqual(["coder", "general", "reviewer"])
    }),
  )

  it.instance("tolerates a failed proposer and still synthesizes", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* MoaTool
      const def = yield* tool.init()
      const promptOps = stubOps((input) => {
        if (input.agent === "reviewer") throw new Error("reviewer exploded")
        if (input.agent === "general") return "synthesis from coder only"
        return "coder proposal"
      })

      const result = yield* def.execute(
        {
          description: "design cache",
          prompt: "design a cache layer",
          proposers: ["coder", "reviewer"],
        },
        ctxOf(chat, assistant, promptOps),
      )

      expect(result.output).toContain("synthesis from coder only")
      expect(result.output).toContain('agent="reviewer"')
      expect(result.output).toContain('ok="false"')
      expect(result.output).toContain('ok="true"')
    }),
  )

  it.instance("supports a custom aggregator and multiple rounds", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* MoaTool
      const def = yield* tool.init()
      const seen: SessionPrompt.PromptInput[] = []
      const promptOps = stubOps((input) => {
        seen.push(input)
        if (input.agent === "architect") return `round synthesis ${seen.filter((item) => item.agent === "architect").length}`
        return "proposal text"
      })

      const result = yield* def.execute(
        {
          description: "design cache",
          prompt: "design a cache layer",
          proposers: ["coder"],
          aggregator: "architect",
          rounds: 2,
        },
        ctxOf(chat, assistant, promptOps),
      )

      expect(result.metadata.aggregator).toBe("architect")
      expect(result.metadata.rounds).toBe(2)
      expect(result.output).toContain("<synthesis>\nround synthesis 2\n</synthesis>")
      expect(result.output).toContain('rounds="2"')
      const roundTwo = seen.find(
        (input) => input.agent === "coder" && input.parts.some((part) => part.type === "text" && part.text.includes("round synthesis 1")),
      )
      expect(roundTwo).toBeDefined()
    }),
  )

  it.instance("rejects unknown proposers with available types", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* MoaTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "design cache",
            prompt: "design a cache layer",
            proposers: ["nope"],
          },
          ctxOf(chat, assistant, stubOps(() => "unused")),
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("rejects rounds above the cap", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* MoaTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "design cache",
            prompt: "design a cache layer",
            proposers: ["coder"],
            rounds: 99,
          },
          ctxOf(chat, assistant, stubOps(() => "unused")),
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )
})

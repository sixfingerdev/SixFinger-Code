import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export type AskInput = {
  sessionID: SessionID
  question: string
  model?: { providerID: string; modelID: string }
}

export class SideQuestionError extends Schema.TaggedErrorClass<SideQuestionError>()("SideQuestionError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<{ response: string }, SideQuestionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SideQuestion") {}

/**
 * Answer a one-off side question without touching the session transcript.
 *
 * The call reuses the session's history, system prompt assembly, and agent so
 * the request prefix stays as close as possible to the main loop's, then runs
 * a single LLM turn with no tools and toolChoice "none". Nothing is persisted:
 * no message rows, no session updates, no events.
 */
const WRAP = [
  "<system-reminder>",
  "The user asked a side question. Answer it directly in this single response.",
  "",
  "Constraints:",
  "- You are a separate, lightweight agent answering exactly one question; the main conversation is NOT interrupted and continues independently.",
  "- You have no tools available: do not read files, run commands, search the web, or take any action.",
  "- This is a one-off response: there is no follow-up turn.",
  "- Answer only from the conversation context you already have. Never say you will check, look up, or investigate anything.",
  "</system-reminder>",
  "",
  "<question>",
].join("\n")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const sys = yield* SystemPrompt.Service
    const instruction = yield* Instruction.Service

    const fail = (message: string) => new SideQuestionError({ message })

    const resolveModel = Effect.fn("SideQuestion.resolveModel")(function* (
      input: AskInput,
      infos: SessionV1.Info[],
    ) {
      if (input.model) {
        return yield* provider
          .getModel(ProviderV2.ID.make(input.model.providerID), ModelV2.ID.make(input.model.modelID))
          .pipe(Effect.mapError(() => fail(`Unknown model ${input.model!.providerID}/${input.model!.modelID}`)))
      }
      const lastAssistant = infos.findLast((info): info is SessionV1.Assistant => info.role === "assistant")
      if (lastAssistant) {
        return yield* provider
          .getModel(ProviderV2.ID.make(lastAssistant.providerID), ModelV2.ID.make(lastAssistant.modelID))
          .pipe(Effect.mapError(() => fail(`Unknown model ${lastAssistant.providerID}/${lastAssistant.modelID}`)))
      }
      const lastUser = infos.findLast((info): info is SessionV1.User => info.role === "user")
      if (lastUser) {
        return yield* provider
          .getModel(ProviderV2.ID.make(lastUser.model.providerID), ModelV2.ID.make(lastUser.model.modelID))
          .pipe(Effect.mapError(() => fail(`Unknown model ${lastUser.model.providerID}/${lastUser.model.modelID}`)))
      }
      return yield* Effect.fail(fail("No model has been used in this session yet"))
    })

    const ask = Effect.fn("SideQuestion.ask")(function* (input: AskInput) {
      const question = input.question.trim()
      if (!question) return yield* Effect.fail(fail("Question is empty"))

      const session = yield* sessions
        .get(input.sessionID)
        .pipe(Effect.mapError(() => fail(`Unknown session ${input.sessionID}`)))
      const history = yield* sessions
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.mapError(() => fail(`Unknown session ${input.sessionID}`)))
      // Drop a trailing assistant message that is still streaming so the side
      // question sees a settled conversation, mirroring the main loop's view.
      const last = history.at(-1)
      const settled =
        last && last.info.role === "assistant" && !last.info.time.completed ? history.slice(0, -1) : history
      const infos = settled.map((message) => message.info)

      const model = yield* resolveModel(input, infos)
      const lastUser = infos.findLast((info): info is SessionV1.User => info.role === "user")
      if (!lastUser) return yield* Effect.fail(fail("Session has no messages yet"))
      const agent = yield* agents.get(lastUser.agent).pipe(Effect.mapError(() => fail("Unknown agent")))

      const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
        sys.skills(agent),
        sys.environment(model),
        instruction.system().pipe(Effect.orDie),
        sys.mcp(agent, session.permission),
        MessageV2.toModelMessagesEffect(settled, model),
      ])
      const system = [...env, ...instructions, ...(mcpInstructions ? [mcpInstructions] : []), ...(skills ? [skills] : [])]

      let response = ""
      yield* llm
        .stream({
          user: lastUser,
          sessionID: input.sessionID,
          parentSessionID: session.parentID,
          model,
          agent,
          permission: session.permission,
          system,
          messages: [...modelMsgs, { role: "user" as const, content: `${WRAP}\n${question}\n</question>` }],
          tools: {},
          toolChoice: "none",
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (LLMEvent.is.textDelta(event)) response += event.text
            }),
          ),
          Effect.catchCause((cause) => Effect.fail(fail(cause instanceof Error ? cause.message : String(cause)))),
        )

      const text = response.trim()
      if (!text) return yield* Effect.fail(fail("No response received"))
      return { response: text }
    })

    return Service.of({ ask })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Agent.node, Provider.node, LLM.node, SystemPrompt.node, Instruction.node],
})

export * as SideQuestion from "./side-question"

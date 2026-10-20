import * as Tool from "./tool"
import DESCRIPTION from "./moa.txt"
import { Session } from "@/session/session"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { Cause, Effect, Schema } from "effect"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Database } from "@sixfinger/core/database/database"

const id = "moa"
const MAX_ROUNDS = 5
const PROPOSAL_PREVIEW = 1500

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task every proposer works on independently" }),
  proposers: Schema.Array(Schema.String).annotate({
    description:
      "Agent types that propose independently in parallel (for example coder, reviewer, researcher). At least one. Diversity is the point: different roles produce different angles.",
  }),
  aggregator: Schema.optional(Schema.String).annotate({
    description: "Agent type that synthesizes the proposals into one answer. Defaults to general.",
  }),
  rounds: Schema.optional(Schema.Number).annotate({
    description: "How many propose-synthesize layers to run (default 1, maximum 5). Later rounds see the previous synthesis.",
  }),
})

type Proposal = { agent: string; sessionID: SessionID; ok: boolean; text: string }

function renderOutput(input: { rounds: number; synthesis: string; proposals: Proposal[] }) {
  const previews = input.proposals
    .map((proposal) => {
      const body =
        proposal.text.length > PROPOSAL_PREVIEW
          ? `${proposal.text.slice(0, PROPOSAL_PREVIEW)}\n... (truncated)`
          : proposal.text
      return `<proposal agent="${proposal.agent}" session="${proposal.sessionID}" ok="${proposal.ok}">\n${body}\n</proposal>`
    })
    .join("\n")
  return [
    `<moa rounds="${input.rounds}" proposals="${input.proposals.length}">`,
    `<synthesis>`,
    input.synthesis,
    `</synthesis>`,
    previews,
    `</moa>`,
  ].join("\n")
}

const AGGREGATOR_INSTRUCTION = [
  "You are the aggregator in a mixture-of-agents run. Below are independent proposals from other agents for the same task.",
  "Synthesize them into a single best answer: merge strengths, resolve contradictions explicitly, and drop weak or duplicated points.",
  "Do NOT just pick one proposal. The output must read as one coherent answer, not a comparison.",
  "If the proposals fundamentally disagree, say so, explain the tradeoff, and recommend one path with reasons.",
].join("\n")

export const MoaTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service

    const run = Effect.fn("MoaTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      if (params.proposers.length === 0) {
        return yield* Effect.fail(new Error("proposers must list at least one agent type."))
      }
      const rounds = params.rounds ?? 1
      if (!Number.isInteger(rounds) || rounds < 1) {
        return yield* Effect.fail(new Error(`rounds must be a positive integer, got: ${params.rounds}.`))
      }
      if (rounds > MAX_ROUNDS) {
        return yield* Effect.fail(new Error(`rounds is capped at ${MAX_ROUNDS} to bound cost.`))
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: params.proposers,
          always: ["*"],
          metadata: { description: params.description },
        })
      }

      const infos = new Map((yield* agent.list()).map((item) => [item.name, item]))
      const unknown = params.proposers.filter((name) => !infos.has(name))
      if (unknown.length > 0) {
        const available = [...infos.keys()].toSorted((a, b) => a.localeCompare(b))
        return yield* Effect.fail(
          new Error(`Unknown agent type(s): ${unknown.map((name) => `"${name}"`).join(", ")}. Available types: ${available.join(", ") || "(none)"}.`),
        )
      }
      const aggregatorName = params.aggregator ?? "general"
      const aggregatorInfo = infos.get(aggregatorName)
      if (!aggregatorInfo) {
        const available = [...infos.keys()].toSorted((a, b) => a.localeCompare(b))
        return yield* Effect.fail(
          new Error(`Unknown aggregator: "${aggregatorName}". Available types: ${available.join(", ") || "(none)"}.`),
        )
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant
      const fallbackModel = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("MoaTool requires promptOps in ctx.extra"))

      const children: SessionID[] = []
      const cancelChildren = Effect.forEach(children.splice(0), (sessionID) => ops.cancel(sessionID), {
        discard: true,
      })

      const spawn = Effect.fn("MoaTool.spawn")(function* (input: {
        agentType: string
        title: string
        prompt: string
      }) {
        const info = infos.get(input.agentType)!
        const childPermission = deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: info,
        })
        const child = yield* sessions.create({
          parentID: ctx.sessionID,
          title: input.title,
          agent: info.name,
          permission: [
            ...childPermission,
            ...(info.permission.some((rule) => rule.permission === "todowrite")
              ? []
              : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
            ...(info.permission.some((rule) => rule.permission === "task")
              ? []
              : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
          ],
        })
        children.push(child.id)
        const parts = yield* ops.resolvePromptParts(input.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: info.model ?? fallbackModel,
          variant: info.model ? undefined : variant,
          agent: info.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          const data = result.info.error.data
          const message = "message" in data && typeof data.message === "string" ? data.message : result.info.error.name
          return yield* Effect.fail(new Error(`${info.name} failed: ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* Effect.fail(new Error(`${info.name} failed: ${failed.state.error}`))
        }
        return { sessionID: child.id, text: result.parts.findLast((item) => item.type === "text")?.text ?? "" }
      })

      const body = Effect.fn("MoaTool.rounds")(function* () {
        let synthesis = ""
        let proposals: Proposal[] = []
        for (let round = 1; round <= rounds; round++) {
          const taskPrompt =
            round === 1
              ? params.prompt
              : [
                  params.prompt,
                  `Previous synthesis (round ${round - 1}):`,
                  synthesis,
                  `Improve on it: address weaknesses, merge strengths, resolve open disagreements.`,
                ].join("\n\n")
          const settled = yield* Effect.forEach(
            params.proposers,
            (agentType) =>
              spawn({
                agentType,
                title: `${params.description} (@${agentType} moa proposal, round ${round})`,
                prompt: taskPrompt,
              }).pipe(
                Effect.map((result) => ({
                  agent: agentType,
                  sessionID: result.sessionID,
                  ok: true as const,
                  text: result.text,
                })),
                Effect.catchCause((cause) => {
                  const failure = Cause.squash(cause)
                  const detail = failure instanceof Error ? failure.message : String(failure)
                  return Effect.succeed({
                    agent: agentType,
                    sessionID: ctx.sessionID,
                    ok: false as const,
                    text: `proposer failed: ${detail}`,
                  })
                }),
              ),
            { concurrency: "unbounded" },
          )
          proposals = settled
          const succeeded = proposals.filter((item) => item.ok)
          if (succeeded.length === 0) {
            return yield* Effect.fail(
              new Error(`All proposers failed in round ${round}: ${proposals.map((item) => item.text).join(" | ")}`),
            )
          }
          const numbered = succeeded
            .map((item, index) => `### Proposal ${index + 1} (from ${item.agent}):\n${item.text}`)
            .join("\n\n")
          synthesis = (
            yield* spawn({
              agentType: aggregatorName,
              title: `${params.description} (@${aggregatorName} moa synthesis, round ${round})`,
              prompt: [AGGREGATOR_INSTRUCTION, `Original task:\n${params.prompt}`, numbered].join("\n\n"),
            })
          ).text
        }
        return { synthesis, proposals }
      })

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          parentSessionId: ctx.sessionID,
          proposers: params.proposers,
          aggregator: aggregatorName,
          rounds,
        },
      })

      const { synthesis, proposals } = yield* body().pipe(Effect.onInterrupt(() => cancelChildren))

      return {
        title: params.description,
        metadata: {
          parentSessionId: ctx.sessionID,
          proposers: params.proposers,
          aggregator: aggregatorName,
          rounds,
        },
        output: renderOutput({ rounds, synthesis, proposals }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

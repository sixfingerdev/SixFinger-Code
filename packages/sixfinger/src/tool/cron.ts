import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { Cron } from "@/session/cron"
import { registerOS, unregisterOS } from "@/session/cron-os"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { TaskPromptOps } from "./task"

const id = "cron"

export const CreateParameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Short name for the scheduled task." }),
  schedule: Schema.String.annotate({
    description: 'When it runs: "every:5m", "every:2h", or a cron expression like "0 9 * * 1-5" (server local time).',
  }),
  prompt: Schema.String.annotate({ description: "The prompt to run at each firing." }),
  session: Schema.optional(Schema.Literals(["new", "existing"])).annotate({
    description:
      '"new" (default): each firing runs in a fresh session. "existing": fires into the named session (requires session_id).',
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: 'Target session for session "existing".',
  }),
  os_scheduled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also register with the OS scheduler so the task fires while sixfinger is closed. Runs headlessly; the transcript lands in the session database.",
  }),
})

export const DeleteParameters = Schema.Struct({
  cron_id: Schema.String.annotate({ description: "Cron ID returned by cron_create." }),
})

export const ListParameters = Schema.Struct({})

export const CronCreateTool = Tool.define<
  typeof CreateParameters,
  { output: string },
  FSUtil.Service | BackgroundJob.Service | Session.Service
>(
  "cron_create",
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: CreateParameters,
      execute: (params: Schema.Schema.Type<typeof CreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "cron",
            patterns: [params.name],
            always: [params.name],
            metadata: { schedule: params.schedule },
          })
          const entry = yield* Cron.create({
            fsys,
            directory: (yield* InstanceState.context).directory,
            name: params.name,
            schedule: params.schedule,
            prompt: params.prompt,
            session: params.session,
            sessionID: params.session_id,
          })
          let osNote = "in-app only (fires while sixfinger is open)"
          if (params.os_scheduled === true) {
            const registered = yield* registerOS({ fsys, entry }).pipe(Effect.ignore)
            void registered
            const marked = { ...entry, osScheduled: true }
            yield* Cron.save({ fsys, entry: marked })
            osNote = "os-scheduled (fires while sixfinger is closed too)"
          }
          // Dynamic import: cron-scheduler pulls in SessionPrompt, which
          // depends back on the tool registry (TDZ cycle if static).
          const { CronScheduler, fireText } = yield* Effect.promise(() => import("@/session/cron-scheduler"))
          yield* CronScheduler.arm({
            fsys,
            background,
            sessions,
            id: entry.id,
            fallbackParentID: ctx.sessionID,
            fire: ({ sessionID, entry, firedAt }) => {
              const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
              if (!ops) return Effect.void
              return ops
                .prompt({ sessionID, parts: [{ type: "text", synthetic: true, text: fireText(entry, firedAt) }] })
                .pipe(Effect.ignore)
            },
          }).pipe(Effect.ignore)
          const output = [
            `Scheduled "${entry.name}" (${entry.id}) every ${entry.schedule}, next run ${new Date(entry.nextRun).toLocaleString()}.`,
            `Target: session "${entry.session}". ${osNote}.`,
            `Stop it with cron_delete.`,
          ].join(" ")
          return { title: `Cron ${entry.name} created`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const CronListTool = Tool.define<typeof ListParameters, { output: string }, FSUtil.Service>(
  "cron_list",
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    return {
      description: "List scheduled tasks with their next run times.",
      parameters: ListParameters,
      execute: () =>
        Effect.gen(function* () {
          const entries = yield* Cron.list({ fsys })
          if (entries.length === 0) {
            const output = "No scheduled tasks."
            return { title: "No crons", metadata: { output }, output }
          }
          const now = Date.now()
          const output = entries
            .map((entry) =>
              entry.enabled && entry.nextRun < now ? `${Cron.describe(entry)} (OVERDUE — missed while away)` : Cron.describe(entry),
            )
            .join("\n")
          return { title: `${entries.length} cron(s)`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const CronDeleteTool = Tool.define<
  typeof DeleteParameters,
  { output: string },
  FSUtil.Service | BackgroundJob.Service
>(
  "cron_delete",
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const background = yield* BackgroundJob.Service
    return {
      description: "Delete a scheduled task, including its OS scheduler registration.",
      parameters: DeleteParameters,
      execute: (params: Schema.Schema.Type<typeof DeleteParameters>) =>
        Effect.gen(function* () {
          const entry = yield* Cron.get({ fsys, id: params.cron_id })
          if (entry?.osScheduled === true) {
            yield* unregisterOS({ fsys, id: entry.id }).pipe(Effect.ignore)
          }
          yield* background.cancel(params.cron_id).pipe(Effect.ignore)
          const ok = yield* Cron.remove({ fsys, id: params.cron_id })
          if (!ok) throw new Error(`Unknown cron: "${params.cron_id}".`)
          const output = `Deleted cron ${params.cron_id}.`
          return { title: "Cron deleted", metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Identifier } from "@opencode-ai/core/id/id"
import { BackgroundJob } from "@/background/job"
import { SessionStatus } from "@/session/status"
import type { TaskPromptOps } from "./task"

const MAX_WAKEUP_MS = 24 * 60 * 60 * 1000
const IDLE_GRACE_MS = 30 * 60 * 1000

export const Parameters = Schema.Struct({
  action: Schema.Literals(["schedule", "list", "cancel"]).annotate({
    description: "schedule: one-shot wakeup. list: show pending wakeups. cancel: cancel a scheduled wakeup.",
  }),
  at: Schema.optional(Schema.String).annotate({
    description:
      'Local clock time to wake up at: "HH:MM" (today, or tomorrow if already past) or an ISO datetime. Required for schedule. Exactly one of at or in_ms.',
  }),
  in_ms: Schema.optional(PositiveInt).annotate({
    description: "Wake up after this many milliseconds. Required for schedule. Exactly one of at or in_ms.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "What to do when waking up. Required for schedule. This text starts your next turn at wake time.",
  }),
  wakeup_id: Schema.optional(Schema.String).annotate({ description: "Wakeup ID returned by schedule. Required for cancel." }),
})

function clock(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false })
}

function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`
}

function resolveWakeAt(input: { at?: string; in_ms?: number }, now: number) {
  if (input.at !== undefined) {
    const match = input.at.match(/^(\d{1,2}):(\d{2})$/)
    if (match) {
      const date = new Date(now)
      date.setHours(Number(match[1]), Number(match[2]), 0, 0)
      if (date.getTime() <= now) date.setDate(date.getDate() + 1)
      return date.getTime()
    }
    const parsed = Date.parse(input.at)
    if (Number.isNaN(parsed)) throw new Error(`Invalid at value: "${input.at}". Use "HH:MM" local time or an ISO datetime.`)
    return parsed
  }
  return now + (input.in_ms ?? 0)
}

export const WakeupTool = Tool.define(
  "wakeup",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    type WakeupMeta = {
      output: string
      userOutput?: string
      background?: boolean
      jobId?: string
      started_at?: number
      activity?: { kind: "wakeup"; id: string; note: string; started_at: number; deadline: number }
    }

    const describe = (info: BackgroundJob.Info) => {
      const wakeAt = typeof info.metadata?.wake_at === "number" ? info.metadata.wake_at : undefined
      const note = typeof info.metadata?.note === "string" ? info.metadata.note : ""
      const remaining = wakeAt === undefined ? "" : wakeAt <= Date.now() ? " (due)" : `, wakes in ${duration(wakeAt - Date.now())}`
      return `${info.id} — wakes at ${wakeAt === undefined ? "?" : clock(wakeAt)}${remaining}: ${note}`
    }

    const describeUser = (info: BackgroundJob.Info) => {
      const wakeAt = typeof info.metadata?.wake_at === "number" ? info.metadata.wake_at : undefined
      const note = typeof info.metadata?.note === "string" ? info.metadata.note : ""
      const remaining = wakeAt === undefined ? "" : wakeAt <= Date.now() ? " (due)" : `, wakes in ${duration(wakeAt - Date.now())}`
      return `Wakes at ${wakeAt === undefined ? "?" : clock(wakeAt)}${remaining}${note ? `: ${note}` : ""}`
    }

    return {
      description: [
        "Schedule a one-shot wakeup: the session continues normally now, and at the requested time a new turn starts automatically with your note.",
        "Use when you finished a reply but want to check back later (for example: a background job is running and you want to look at its output in 5 minutes), or when the user asks for a reminder at a clock time.",
        "Wakeups fire between turns: if the session is busy at wake time it fires as soon as the current turn ends. Session-only: closing opencode drops pending wakeups.",
        "For waiting inside the current turn instead, use the sleep tool. List or cancel wakeups with the other actions.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<WakeupMeta>> =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const jobs = (yield* background.list()).filter((job) => job.type === "wakeup" && job.status === "running")
            if (jobs.length === 0)
              return {
                title: "No wakeups",
                metadata: { output: "No scheduled wakeups.", userOutput: "No scheduled wakeups." },
                output: "No scheduled wakeups.",
              }
            const output = jobs.map(describe).join("\n")
            const userOutput = jobs.map(describeUser).join("\n")
            return { title: `${jobs.length} wakeup(s)`, metadata: { output, userOutput }, output }
          }

          if (params.action === "cancel") {
            if (!params.wakeup_id) throw new Error(`wakeup_id is required for action "cancel".`)
            const info = yield* background.cancel(params.wakeup_id)
            if (!info) throw new Error(`No scheduled wakeup with ID: ${params.wakeup_id}`)
            const output = `Cancelled wakeup ${info.id}.`
            const note = typeof info.metadata?.note === "string" && info.metadata.note ? `: ${info.metadata.note}` : ""
            return { title: `Cancelled ${info.id}`, metadata: { output, userOutput: `Wakeup cancelled${note}.` }, output }
          }

          if ((params.at === undefined) === (params.in_ms === undefined)) {
            throw new Error('Provide exactly one of at ("HH:MM" or ISO datetime) or in_ms.')
          }
          if (!params.note) throw new Error('note is required for action "schedule".')
          const started_at = Date.now()
          const wake_at = resolveWakeAt(params, started_at)
          if (wake_at <= started_at) throw new Error(`Wake time is in the past: "${params.at}".`)
          if (wake_at - started_at > MAX_WAKEUP_MS) throw new Error("Maximum wakeup horizon is 24 hours.")

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) throw new Error("Wakeup requires promptOps in tool context.")

          const id = Identifier.ascending("job")
          const fire = Effect.gen(function* () {
            yield* Effect.sleep(`${Math.max(0, wake_at - Date.now())} millis`)
            const grace = Date.now() + IDLE_GRACE_MS
            let waited = false
            while (Date.now() < grace) {
              const current = yield* status.get(ctx.sessionID)
              if (current.type === "idle") break
              waited = true
              yield* Effect.sleep("1 second")
            }
            const woke_at = Date.now()
            const text = [
              `<wakeup id="${id}" scheduled_at="${started_at}" woke_at="${woke_at}" waited_for_idle="${waited}">`,
              `Scheduled wakeup fired at ${clock(woke_at)} local time (requested ${clock(wake_at)}, ${duration(woke_at - started_at)} after scheduling${waited ? ", waited for the current turn to finish" : ""}).`,
              `Your note: ${params.note}`,
              `</wakeup>`,
            ].join("\n")
            yield* ops.prompt({
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              parts: [{ type: "text", synthetic: true, text }],
            })
            return `wakeup ${id} fired at ${clock(woke_at)}`
          })

          yield* background.start({
            id,
            type: "wakeup",
            title: params.note.length > 60 ? `${params.note.slice(0, 60)}...` : params.note,
            metadata: {
              background: true,
              sessionID: ctx.sessionID,
              note: params.note,
              wake_at,
            },
            run: fire,
          })

          const output = [
            `<wakeup id="${id}" state="scheduled" wake_at="${wake_at}">`,
            `Wakeup scheduled at ${clock(wake_at)} local time (${duration(wake_at - started_at)} from now). Started at ${clock(started_at)}.`,
            `When it fires, a new turn starts automatically with your note; nothing else is needed. The conversation continues normally until then.`,
            `Cancel with action "cancel", wakeup_id "${id}".`,
            `</wakeup>`,
          ].join("\n")
          return {
            title: `Wakeup at ${clock(wake_at)}`,
            metadata: {
              output,
              userOutput: `Wakeup scheduled for ${clock(wake_at)}${params.note ? `: ${params.note}` : ""}`,
              background: true,
              jobId: id,
              started_at,
              activity: { kind: "wakeup" as const, id, note: params.note, started_at, deadline: wake_at },
            },
            output,
          }
        }),
    }
  }),
)

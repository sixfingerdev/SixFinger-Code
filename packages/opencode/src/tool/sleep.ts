import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@opencode-ai/core/schema"

const MAX_SLEEP_MS = 60 * 60 * 1000

export const Parameters = Schema.Struct({
  duration_ms: Schema.optional(PositiveInt).annotate({
    description: "How long to sleep in milliseconds (maximum 3600000 = 1 hour). Exactly one of duration_ms or until is required.",
  }),
  until: Schema.optional(Schema.String).annotate({
    description:
      'Local clock time to wake up at: "HH:MM" (today, or tomorrow if that time already passed) or a full ISO datetime. Exactly one of duration_ms or until is required.',
  }),
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

function resolveWakeAt(params: Schema.Schema.Type<typeof Parameters>, now: number) {
  if (params.until !== undefined) {
    const match = params.until.match(/^(\d{1,2}):(\d{2})$/)
    if (match) {
      const date = new Date(now)
      date.setHours(Number(match[1]), Number(match[2]), 0, 0)
      if (date.getTime() <= now) date.setDate(date.getDate() + 1)
      return date.getTime()
    }
    const parsed = Date.parse(params.until)
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid until value: "${params.until}". Use "HH:MM" local time or an ISO datetime.`)
    }
    return parsed
  }
  return now + (params.duration_ms ?? 0)
}

export const SleepTool = Tool.define(
  "sleep",
  Effect.gen(function* () {
    return {
      description: [
        "Wait until a duration elapses or a clock time arrives, then return control. The session stays blocked while sleeping but this costs no tokens.",
        "Use this to wait before checking on a background job, a monitor, or anything outside the session: sleep, then Read the background output file or check the result.",
        "The sleep can be interrupted by the user at any time. Prefer this over Bash(sleep ...) because it holds no shell process.",
        "Maximum sleep is 1 hour. For longer waits, sleep again after waking.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (
            (params.duration_ms === undefined) === (params.until === undefined) ||
            (params.duration_ms !== undefined && params.duration_ms > MAX_SLEEP_MS)
          ) {
            throw new Error(
              "Provide exactly one of duration_ms (1-3600000) or until (local HH:MM or ISO datetime).",
            )
          }
          const started_at = Date.now()
          const wakeAt = resolveWakeAt(params, started_at)
          if (wakeAt <= started_at) throw new Error(`Wake time is in the past: "${params.until}".`)
          if (wakeAt - started_at > MAX_SLEEP_MS) {
            throw new Error("Maximum sleep is 1 hour. Sleep again after waking if you need to wait longer.")
          }
          yield* ctx.metadata({
            metadata: {
              output: `Sleeping until ${clock(wakeAt)}`,
            },
          })
          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })
          const done = yield* Effect.raceAll([
            Effect.sleep(`${wakeAt - started_at} millis`).pipe(Effect.map(() => "done" as const)),
            abort.pipe(Effect.map(() => "aborted" as const)),
          ])
          const woke_at = Date.now()
          if (done === "aborted") {
            return {
              title: `Sleep interrupted after ${duration(woke_at - started_at)}`,
              metadata: {
                output: `Sleep interrupted after ${duration(woke_at - started_at)}`,
                interrupted: true,
                started_at,
                woke_at,
                until: wakeAt,
                activity: { kind: "sleep" as const, started_at, until: wakeAt, done: true },
              },
              output: `Sleep interrupted by the user after ${duration(woke_at - started_at)}. It is ${clock(woke_at)} local time.`,
            }
          }
          return {
            title: `Slept ${duration(woke_at - started_at)}`,
            metadata: {
              output: `Woke at ${clock(woke_at)}`,
              interrupted: false,
              started_at,
              woke_at,
              until: wakeAt,
              activity: { kind: "sleep" as const, started_at, until: wakeAt, done: true },
            },
            output: [
              `Woke up at ${clock(woke_at)} local time after sleeping ${duration(woke_at - started_at)}.`,
              `Now check whatever you were waiting for (background job output file, monitor events, external state).`,
            ].join(" "),
          }
        }),
    }
  }),
)

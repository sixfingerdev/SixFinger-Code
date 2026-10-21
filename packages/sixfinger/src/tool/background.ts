import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "stop"]).annotate({
    description: "list: show all background jobs. get: show one job with its output. stop: cancel a running job.",
  }),
  job_id: Schema.optional(Schema.String).annotate({
    description: "Job ID returned by bash (background), monitor, or sleep flows. Required for get and stop.",
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

function describe(info: BackgroundJob.Info) {
  const elapsed = duration((info.completed_at ?? Date.now()) - info.started_at)
  const head = `${info.id} [${info.type}] ${info.title ?? "(no title)"} — ${info.status}, started at ${clock(info.started_at)}, running for ${elapsed}`
  if (info.status === "running") return head
  if (info.status === "error") return `${head}\nError: ${info.error ?? "unknown"}`
  return head
}

function describeUser(info: BackgroundJob.Info) {
  const elapsed = duration((info.completed_at ?? Date.now()) - info.started_at)
  const head = `[${info.type}] ${info.title ?? "(no title)"} — ${info.status}, started at ${clock(info.started_at)}, running for ${elapsed}`
  if (info.status === "error") return `${head}\nError: ${info.error ?? "unknown"}`
  return head
}

export const BackgroundTool = Tool.define(
  "background",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    return {
      description: [
        "Inspect and control background jobs started by bash (background), monitor, or sleep flows.",
        "Jobs never die on their own: list them to see elapsed time, get one to read its output, stop one to kill it.",
        "Read large outputs with the Read tool via the output file path when one is reported.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const jobs = yield* background.list()
            if (jobs.length === 0) {
              return {
                title: "No background jobs",
                metadata: { output: "No background jobs.", userOutput: "No background jobs." },
                output: "No background jobs.",
              }
            }
            const output = jobs.map(describe).join("\n")
            const userOutput = jobs.map(describeUser).join("\n")
            return { title: `${jobs.length} background jobs`, metadata: { output, userOutput }, output }
          }
          if (!params.job_id) throw new Error(`job_id is required for action "${params.action}".`)
          if (params.action === "stop") {
            const info = yield* background.cancel(params.job_id)
            if (!info) throw new Error(`No background job with ID: ${params.job_id}`)
            const output = `Stopped ${info.id} [${info.type}] ${info.title ?? ""} (was ${info.status}).`
            const userOutput = `Stopped: ${info.title ?? info.type} (was ${info.status}).`
            return { title: `Stopped ${info.id}`, metadata: { output, userOutput }, output }
          }
          const info = yield* background.get(params.job_id)
          if (!info) throw new Error(`No background job with ID: ${params.job_id}`)
          const output = [describe(info), "", info.output?.trim() ? info.output : "(no output yet)"].join("\n")
          const userOutput = [describeUser(info), "", info.output?.trim() ? info.output : "(no output yet)"].join("\n")
          return {
            title: info.title ?? info.id,
            metadata: {
              output: output.length > 8000 ? `...truncated...\n\n${output.slice(-8000)}` : output,
              userOutput: userOutput.length > 8000 ? `...truncated...\n\n${userOutput.slice(-8000)}` : userOutput,
            },
            output,
          }
        }),
    }
  }),
)

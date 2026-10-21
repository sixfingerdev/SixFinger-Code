import { createEffect, createSignal, onCleanup } from "solid-js"
import type { Message, Part, ToolPart } from "@sixfinger/sdk/v2"

export type ActivityJobKind = "bash" | "monitor" | "wakeup" | "sleep"

export type ActivityJobSource = {
  part: ToolPart
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
}

export type ActivityJob = {
  id: string
  kind: ActivityJobKind
  icon: string
  title: string
  startedAt: number
  deadline?: number
  /** Raw tool part backing this job; missing for marker-only candidates. */
  source?: ActivityJobSource
}

type Candidate = ActivityJob & { state: "running" | "done" | "cancelled" }/**
 * One-tick-per-second signal for live duration counters. The interval only
 * runs while `active` is true and is cleaned up automatically.
 */
export function useClockTick(active: () => boolean) {
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    if (!active()) return
    const interval = setInterval(() => setTick((value) => value + 1), 1000)
    onCleanup(() => clearInterval(interval))
  })
  return tick
}

export function formatClock(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false })
}

/**
 * Hide internal job ids from user-facing text. The model keeps seeing them so
 * it can cancel jobs; users never need them.
 */
export function stripJobIds(text: string): string {
  return text.replace(/job_[a-zA-Z0-9]+/g, "[job]")
}

/**
 * Transform machine-facing job markers (`<wakeup ...>`, `<background_job ...>`,
 * `<monitor_event ...>`) into user-friendly text. The model keeps receiving the
 * raw XML; every user-facing surface renders through this instead.
 */
export function friendlyJobText(text: string): string {
  let out = text

  out = out.replace(
    /<wakeup id="[^"]+" state="scheduled" wake_at="(\d+)"[^>]*>[\s\S]*?<\/wakeup>/g,
    (_match: string, wakeAt: string) => `◷ Wakeup scheduled for ${formatClock(Number(wakeAt))}`,
  )

  out = out.replace(
    /<wakeup id="[^"]+" scheduled_at="\d+" woke_at="(\d+)"[^>]*>([\s\S]*?)<\/wakeup>/g,
    (_match: string, wokeAt: string, body: string) => {
      const note = body.match(/Your note:\s*(.+)/)?.[1]?.trim()
      const head = `◷ Wakeup fired at ${formatClock(Number(wokeAt))}`
      return note ? `${head}\n${note}` : head
    },
  )

  out = out.replace(
    /<background_job id="[^"]+" state="running" started_at="\d+"[^>]*>([\s\S]*?)<\/background_job>/g,
    (_match: string, body: string) => {
      const command = body.match(/Command "(.+?)" (started|is still running)/)?.[1]
      const moved = body.includes("moved to the background")
      return `▣ ${command ? `"${command}" ` : ""}${moved ? "moved to the background" : "running in the background"}`
    },
  )

  out = out.replace(
    /<background_job id="[^"]+" state="progress" started_at="\d+"[^>]*>([\s\S]*?)<\/background_job>/g,
    (_match: string, body: string) => {
      const command = body.match(/Background command "(.+?)" is still running/)?.[1]
      const tail = body.match(/New output since your last look:\n([\s\S]*?)\nIt keeps running/)?.[1]?.trim()
      const head = `▣ ${command ? `"${command}" ` : ""}still running · new output:`
      return tail ? `${head}\n${tail}` : head
    },
  )

  out = out.replace(
    /<background_job id="[^"]+" state="(completed|error|cancelled)" started_at="\d+" completed_at="\d+"[^>]*>([\s\S]*?)<\/background_job>/g,
    (_match: string, state: string, body: string) => {
      const icon = state === "error" ? "✗" : state === "cancelled" ? "○" : "▣"
      const label = state === "completed" ? "finished" : state === "error" ? "failed" : "cancelled"
      const result = body.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
      const head = `${icon} Background command ${label}`
      return result ? `${head}\n${result}` : head
    },
  )

  out = out.replace(
    /<monitor_event id="[^"]+" description="[^"]*"[^>]*>([\s\S]*?)<\/monitor_event>/g,
    (_match: string, body: string) => body.trim(),
  )

  return stripJobIds(out)
}

function rec(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function num(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function str(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function truncateTitle(value: string, max = 44) {
  const line = value.split("\n")[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const BACKGROUND_JOB_DONE = /<background_job id="([^"\s]+)" state="(completed|error|cancelled)"/g
const WAKEUP_SCHEDULED = /<wakeup id="([^"\s]+)" state="scheduled" wake_at="(\d+)"/g
const WAKEUP_FIRED = /<wakeup id="([^"\s]+)" scheduled_at="\d+" woke_at="\d+"/g
const JOB_STOPPED = /Stopped (job_\S+)/g
const WAKEUP_CANCELLED = /Cancelled wakeup (job_\S+)/g

function matches(value: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0
  const ids: string[] = []
  for (const match of value.matchAll(pattern)) {
    if (match[1]) ids.push(match[1])
  }
  return ids
}

/**
 * Derive the session's live background activity from the transcript.
 *
 * Backgrounded bash, monitor, and wakeup tools return immediately, so their
 * tool parts are "completed" while the work continues in the BackgroundJob
 * registry. The live state therefore comes from two sources:
 *  - tool part metadata (job id, command/description/note, started_at,
 *    deadline) identifies the job,
 *  - the synthetic messages the tools inject (`<background_job ...>`,
 *    `<wakeup ...>`, background-tool stop/cancel outputs) mark completion or
 *    cancellation.
 * Sleep is the exception: its tool call blocks until it completes, so its
 * part status is the live state.
 */
export function scanActivityJobs(
  messages: ReadonlyArray<Message>,
  partsOf: (messageID: string) => ReadonlyArray<Part>,
): ActivityJob[] {
  const candidates = new Map<string, Candidate>()

  const add = (job: Candidate) => {
    const existing = candidates.get(job.id)
    if (existing && existing.state !== "running") return
    candidates.set(job.id, job)
  }

  const finish = (id: string, state: "done" | "cancelled") => {
    const existing = candidates.get(id)
    if (existing) existing.state = state
    else candidates.set(id, { id, kind: "bash", icon: "?", title: id, startedAt: Date.now(), state })
  }

  for (const message of messages) {
    for (const part of partsOf(message.id)) {
      if (part.type === "tool") {
        const state = part.state
        if (state.status !== "completed" && state.status !== "running") continue
        const metadata = rec(state.metadata) ?? {}
        const input = rec(state.input) ?? {}
        const activity = rec(metadata.activity)
        const source = {
          part: part as ToolPart,
          input,
          metadata,
          output: state.status === "completed" ? state.output : undefined,
        }

        if (part.tool === "bash" && metadata.background === true) {
          const id = str(metadata, "jobId")
          if (!id) continue
          add({
            id,
            kind: "bash",
            icon: "▣",
            title: truncateTitle(str(input, "command") ?? str(metadata, "command") ?? "command"),
            startedAt: num(metadata, "started_at") ?? ("time" in state ? state.time.start : Date.now()),
            deadline: undefined,
            source,
            state: "running",
          })
          continue
        }
        if (part.tool === "monitor" && metadata.background === true) {
          const id = str(metadata, "jobId")
          if (!id) continue
          add({
            id,
            kind: "monitor",
            icon: "◎",
            title: truncateTitle(str(input, "description") ?? "monitor"),
            startedAt: num(metadata, "started_at") ?? ("time" in state ? state.time.start : Date.now()),
            deadline: num(activity, "deadline") ?? num(metadata, "deadline"),
            source,
            state: "running",
          })
          continue
        }
        if (part.tool === "wakeup" && metadata.background === true) {
          const id = str(metadata, "jobId")
          if (!id) continue
          add({
            id,
            kind: "wakeup",
            icon: "◷",
            title: truncateTitle(str(input, "note") ?? "wakeup"),
            startedAt: num(metadata, "started_at") ?? ("time" in state ? state.time.start : Date.now()),
            deadline: num(activity, "deadline") ?? num(metadata, "deadline"),
            source,
            state: "running",
          })
          // The wakeup tool's cancel action reports through its own output.
          if (source.output) {
            for (const cancelled of matches(source.output, WAKEUP_CANCELLED)) finish(cancelled, "cancelled")
          }
          continue
        }
        // The background management tool reports stops/cancellations.
        if (part.tool === "background") {
          const output = source.output
          if (!output) continue
          for (const id of matches(output, JOB_STOPPED)) finish(id, "cancelled")
          for (const id of matches(output, WAKEUP_CANCELLED)) finish(id, "cancelled")
          continue
        }
        // Sleep blocks the whole tool call, so a running sleep part IS live.
        if (part.tool === "sleep" && state.status === "running") {
          const deadline = num(metadata, "until") ?? num(activity, "until")
          candidates.set(`sleep:${part.callID}`, {
            id: `sleep:${part.callID}`,
            kind: "sleep",
            icon: "☾",
            title: deadline !== undefined ? `until ${formatClock(deadline)}` : "sleeping",
            startedAt: "time" in state ? state.time.start : Date.now(),
            deadline,
            source,
            state: "running",
          })
        }
        continue
      }

      if (part.type === "text") {
        const text = part.text
        if (!text) continue
        if (text.includes("<background_job")) {
          for (const id of matches(text, BACKGROUND_JOB_DONE)) finish(id, "done")
        }
        if (text.includes("<wakeup")) {
          for (const match of text.matchAll(WAKEUP_SCHEDULED)) {
            const existing = candidates.get(match[1]!)
            if (existing) existing.deadline = Number(match[2])
            else
              candidates.set(match[1]!, {
                id: match[1]!,
                kind: "wakeup",
                icon: "◷",
                title: "wakeup",
                startedAt: Date.now(),
                deadline: Number(match[2]),
                state: "running",
              })
          }
          for (const id of matches(text, WAKEUP_FIRED)) finish(id, "done")
        }
      }
    }
  }

  return [...candidates.values()]
    .filter((job) => job.state === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ state: _state, ...job }) => job)
}

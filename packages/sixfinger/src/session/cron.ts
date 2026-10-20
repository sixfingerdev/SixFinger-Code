export * as Cron from "./cron"

import { Effect } from "effect"
import { Identifier } from "@sixfinger/core/id/id"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Global } from "@sixfinger/core/global"
import { SessionID } from "@/session/schema"
import path from "path"

/**
 * Recurring scheduled tasks. Each entry is a JSON file under state/cron/.
 *
 * Two schedule kinds:
 *  - "every:5m" | "every:2h" — plain intervals
 *  - 5-field cron "m h dom mon dow" (server local time); each field is a
 *    number or "*"
 *
 * Firing has two paths: while sixfinger is open, an in-app fiber sleeps until
 * nextRun; while closed, an OS scheduler entry (opt-in) runs
 * `sixfinger cron run --due <id>` headlessly.
 */

export type Entry = {
  id: string
  name: string
  schedule: string
  prompt: string
  directory: string
  session: "new" | "existing"
  sessionID?: string
  createdAt: number
  nextRun: number
  lastRun?: number
  enabled: boolean
  osScheduled?: boolean
}

export type Fs = typeof FSUtil.Service

const MINUTE = 60_000
const HOUR = 60 * MINUTE

type CronField = number | "*"

export type CronSpec = {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

export type ParsedSchedule = { kind: "every"; ms: number } | { kind: "cron"; spec: CronSpec }

const STATE_DIR = () => path.join(Global.Path.state, "cron")

function parseEvery(raw: string): number {
  const match = raw.trim().match(/^every:(\d+)(m|h)$/i)
  if (!match) throw new Error(`Invalid interval: "${raw}". Use "every:<n>m" or "every:<n>h".`)
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid interval: "${raw}". Amount must be positive.`)
  return amount * (unit === "h" ? HOUR : MINUTE)
}

function parseField(raw: string, min: number, max: number, label: string): CronField {
  if (raw === "*") return "*"
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid schedule field "${raw}" for ${label}: expected a number or "*".`)
  const value = Number(raw)
  if (value < min || value > max) throw new Error(`Invalid schedule field "${raw}" for ${label}: expected ${min}-${max} or "*".`)
  return value
}

export function parseSchedule(raw: string): ParsedSchedule {
  const trimmed = raw.trim()
  if (/^every:/i.test(trimmed)) return { kind: "every", ms: parseEvery(trimmed) }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid schedule: "${raw}". Use a 5-field cron expression or "every:<n>m|<n>h".`)
  }
  return {
    kind: "cron",
    spec: {
      minute: parseField(parts[0]!, 0, 59, "minute"),
      hour: parseField(parts[1]!, 0, 23, "hour"),
      dom: parseField(parts[2]!, 1, 31, "day of month"),
      month: parseField(parts[3]!, 1, 12, "month"),
      dow: parseField(parts[4]!, 0, 6, "day of week"),
    },
  }
}

function matches(value: number, field: CronField): boolean {
  return field === "*" || field === value
}

/** Next run strictly after `from` (server local time), minute-aligned. */
export function nextRunAfter(parsed: ParsedSchedule, from: number): number {
  if (parsed.kind === "every") return from + parsed.ms
  // Cap the scan at ~400 days to avoid an infinite loop on impossible specs.
  let cursor = Math.floor(from / MINUTE) * MINUTE + MINUTE
  for (let step = 0; step < 366 * 24 * 60; step++) {
    const date = new Date(cursor)
    if (
      matches(date.getMinutes(), parsed.spec.minute) &&
      matches(date.getHours(), parsed.spec.hour) &&
      matches(date.getDate(), parsed.spec.dom) &&
      matches(date.getMonth() + 1, parsed.spec.month) &&
      matches(date.getDay(), parsed.spec.dow)
    ) {
      return cursor
    }
    cursor += MINUTE
  }
  throw new Error("Schedule never matches within a year; refine the cron expression.")
}

export const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)

export const create = Effect.fn("Cron.create")(function* (input: {
  fsys: FSUtil.Interface
  name: string
  schedule: string
  prompt: string
  directory: string
  session?: "new" | "existing"
  sessionID?: string
}) {
  const parsed = parseSchedule(input.schedule)
  if (!input.prompt.trim()) throw new Error("Cron prompt is empty.")
  const session = input.session ?? "new"
  if (session === "existing" && !input.sessionID) {
    throw new Error('session "existing" requires a sessionID.')
  }
  const now = Date.now()
  const info: Entry = {
    id: Identifier.ascending("job"),
    name: input.name.trim() || "cron",
    schedule: input.schedule.trim(),
    prompt: input.prompt,
    directory: input.directory,
    session,
    ...(session === "existing" ? { sessionID: input.sessionID } : {}),
    createdAt: now,
    nextRun: nextRunAfter(parsed, now),
    enabled: true,
  }
  yield* input.fsys
    .writeWithDirs(path.join(STATE_DIR(), `${info.id}.json`), JSON.stringify(info, null, 2))
    .pipe(Effect.orDie)
  return info
})

export const list = Effect.fn("Cron.list")(function* (input: { fsys: FSUtil.Interface }) {
  const exists = yield* input.fsys.existsSafe(STATE_DIR()).pipe(Effect.orDie)
  if (!exists) return []
  const entries = yield* input.fsys.readDirectoryEntries(STATE_DIR()).pipe(Effect.orDie)
  const result: Entry[] = []
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue
    const raw = yield* input.fsys.readFileStringSafe(path.join(STATE_DIR(), entry.name)).pipe(Effect.orDie)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Entry
      if (parsed?.id && parsed?.schedule && parsed?.prompt) result.push(parsed)
    } catch {
      continue
    }
  }
  return result.toSorted((a, b) => a.nextRun - b.nextRun)
})

export const get = Effect.fn("Cron.get")(function* (input: { fsys: FSUtil.Interface; id: string }) {
  const raw = yield* input.fsys
    .readFileStringSafe(path.join(STATE_DIR(), `${input.id}.json`))
    .pipe(Effect.orDie)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Entry
    return parsed?.id === input.id ? parsed : undefined
  } catch {
    return undefined
  }
})

export const remove = Effect.fn("Cron.remove")(function* (input: { fsys: FSUtil.Interface; id: string }) {
  const file = path.join(STATE_DIR(), `${input.id}.json`)
  if (!(yield* input.fsys.existsSafe(file).pipe(Effect.orDie))) return false
  yield* input.fsys.remove(file).pipe(Effect.ignore)
  return true
})

export const save = Effect.fn("Cron.save")(function* (input: { fsys: FSUtil.Interface; entry: Entry }) {
  yield* input.fsys
    .writeWithDirs(path.join(STATE_DIR(), `${input.entry.id}.json`), JSON.stringify(input.entry, null, 2))
    .pipe(Effect.orDie)
})

/** Entries whose run time has passed and are still enabled. */
export const due = Effect.fn("Cron.due")(function* (input: { fsys: FSUtil.Interface; now: number }) {
  const entries = yield* list({ fsys: input.fsys })
  return entries.filter((entry) => entry.enabled && entry.nextRun <= input.now)
})

/** Advance an entry after a firing; computes the run after `now`. */
export const markRun = Effect.fn("Cron.markRun")(function* (input: {
  fsys: FSUtil.Interface
  id: string
  now: number
}) {
  const entry = yield* get({ fsys: input.fsys, id: input.id })
  if (!entry) return undefined
  const parsed = parseSchedule(entry.schedule)
  const updated: Entry = { ...entry, lastRun: input.now, nextRun: nextRunAfter(parsed, input.now) }
  yield* save({ fsys: input.fsys, entry: updated })
  return updated
})

export const describe = (entry: Entry) =>
  `${entry.id} [${entry.enabled ? "on" : "off"}] "${entry.name}" every ${entry.schedule} → next ${new Date(entry.nextRun).toLocaleString()}${entry.osScheduled === true ? " (os-scheduled)" : ""}`

export { SessionID }

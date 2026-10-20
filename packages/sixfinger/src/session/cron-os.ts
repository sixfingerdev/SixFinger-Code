import { Effect } from "effect"
import { execFile } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Cron } from "./cron"

/**
 * OS scheduler registration so cron entries fire while sixfinger is closed.
 * The registered command is always `sixfinger cron run --due <id>`, which runs
 * headlessly and exits. Registration is best-effort and per-platform:
 *  - win32:  Task Scheduler (schtasks)
 *  - darwin: launchd user agent
 *  - linux:  systemd user timer
 */

const label = (id: string) => `sixfinger-cron-${id}`

/** Command array that re-invokes this sixfinger binary for a due entry. */
export function selfCommand(id: string): string[] {
  return [...selfBinary(), "cron", "run", "--due", id]
}

/** The current binary plus entry script when running under an interpreter. */
export function selfBinary(): string[] {
  const exe = process.execPath
  const base = path.basename(exe).toLowerCase().replace(/\.exe$/, "")
  if (base === "bun" || base === "node" || base === "deno") {
    const entry = process.argv[1]
    return entry ? [exe, entry] : [exe]
  }
  return [exe]
}

const shellQuote = (value: string) => `"${value.replace(/"/g, "")}"`

function runFile(argv: string[]) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        execFile(argv[0]!, argv.slice(1), { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()))
      }),
    catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
  })
}

export const registerOS = Effect.fn("CronOS.register")(function* (input: {
  fsys: FSUtil.Interface
  entry: Cron.Entry
}) {
  const parsed = Cron.parseSchedule(input.entry.schedule)
  const args = selfCommand(input.entry.id)
  const command = args.map((part) => (part.includes(" ") ? shellQuote(part) : part)).join(" ")
  if (process.platform === "win32") {
    const task = label(input.entry.id)
    if (parsed.kind === "every") {
      const minutes = Math.floor(parsed.ms / 60_000)
      if (parsed.ms % 60_000 !== 0 || minutes < 1) return { supported: false }
      const unit = minutes % 60 === 0 ? ["hourly", String(minutes / 60)] : ["minute", String(minutes)]
      yield* runFile(["schtasks", "/create", "/tn", task, "/sc", unit[0]!, "/mo", unit[1]!, "/tr", command, "/f"])
      return { supported: true }
    }
    const spec = parsed.spec
    if (spec.dom !== "*" || spec.month !== "*" || typeof spec.minute !== "number" || typeof spec.hour !== "number") {
      return { supported: false }
    }
    const time = `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`
    if (spec.dow === "*") {
      yield* runFile(["schtasks", "/create", "/tn", task, "/sc", "daily", "/st", time, "/tr", command, "/f"])
      return { supported: true }
    }
    if (typeof spec.dow !== "number") return { supported: false }
    const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
    yield* runFile([
      "schtasks",
      "/create",
      "/tn",
      task,
      "/sc",
      "weekly",
      "/d",
      names[spec.dow]!,
      "/st",
      time,
      "/tr",
      command,
      "/f",
    ])
    return { supported: true }
  }
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${label(input.entry.id)}.plist`)
    const calendar = (value: number | "*") => (value === "*" ? "" : `<integer>${value}</integer>`)
    const interval =
      parsed.kind === "every"
        ? `<key>StartInterval</key>\n    <integer>${Math.floor(parsed.ms / 1000)}</integer>`
        : [
            `<key>StartCalendarInterval</key>`,
            `<dict>`,
            `  <key>Minute</key>`,
            `  ${calendar(parsed.spec.minute)}`,
            `  <key>Hour</key>`,
            `  ${calendar(parsed.spec.hour)}`,
            `  <key>Day</key>`,
            `  ${calendar(parsed.spec.dom)}`,
            `  <key>Month</key>`,
            `  ${calendar(parsed.spec.month)}`,
            `  <key>Weekday</key>`,
            `  ${calendar(parsed.spec.dow)}`,
            `</dict>`,
          ].join("\n")
    const plist = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key>`,
      `  <string>${label(input.entry.id)}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      ...args.map((part) => `    <string>${part}</string>`),
      `  </array>`,
      `  ${interval}`,
      `  <key>RunAtLoad</key>`,
      `  <false/>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n")
    yield* input.fsys.writeWithDirs(file, plist).pipe(Effect.orDie)
    yield* runFile(["launchctl", "load", file])
    return { supported: true }
  }
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config", "systemd", "user")
    const service = path.join(dir, `${label(input.entry.id)}.service`)
    const timer = path.join(dir, `${label(input.entry.id)}.timer`)
    const onCalendar =
      parsed.kind === "every" ? `OnUnitActiveSec=${Math.floor(parsed.ms / 1000)}` : cronToSystemd(parsed.spec)
    if (!onCalendar) return { supported: false }
    yield* input.fsys
      .writeWithDirs(
        service,
        [`[Unit]`, `Description=sixfinger cron ${input.entry.id}`, ``, `[Service]`, `Type=oneshot`, `ExecStart=${command}`, ``].join(
          "\n",
        ),
      )
      .pipe(Effect.orDie)
    yield* input.fsys
      .writeWithDirs(
        timer,
        [
          `[Unit]`,
          `Description=sixfinger cron ${input.entry.id} timer`,
          ``,
          `[Timer]`,
          onCalendar,
          `Persistent=true`,
          ``,
          `[Install]`,
          `WantedBy=timers.target`,
          ``,
        ].join("\n"),
      )
      .pipe(Effect.orDie)
    yield* runFile(["systemctl", "--user", "daemon-reload"])
    yield* runFile(["systemctl", "--user", "enable", "--now", path.basename(timer)])
    return { supported: true }
  }
  return { supported: false }
})

function cronToSystemd(spec: {
  minute: number | "*"
  hour: number | "*"
  dom: number | "*"
  month: number | "*"
  dow: number | "*"
}): string | undefined {
  const part = (value: number | "*") => (value === "*" ? "*" : String(value).padStart(2, "0"))
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const dow = spec.dow === "*" ? "" : `${days[spec.dow as number]} `
  if (spec.dom !== "*" || spec.month !== "*") {
    const dom = spec.dom === "*" ? "*" : String(spec.dom).padStart(2, "0")
    const mon = spec.month === "*" ? "*" : String(spec.month).padStart(2, "0")
    return `OnCalendar=${dow}${mon}-${dom}-* ${part(spec.hour)}:${part(spec.minute)}:00`
  }
  return `OnCalendar=${dow}*-*-* ${part(spec.hour)}:${part(spec.minute)}:00`
}

export const unregisterOS = Effect.fn("CronOS.unregister")(function* (input: {
  fsys: FSUtil.Interface
  id: string
}) {
  if (process.platform === "win32") {
    yield* runFile(["schtasks", "/delete", "/tn", label(input.id), "/f"]).pipe(Effect.ignore)
    return
  }
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${label(input.id)}.plist`)
    yield* runFile(["launchctl", "unload", file]).pipe(Effect.ignore)
    yield* input.fsys.remove(file).pipe(Effect.ignore)
    return
  }
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config", "systemd", "user")
    const timer = path.join(dir, `${label(input.id)}.timer`)
    yield* runFile(["systemctl", "--user", "disable", "--now", path.basename(timer)]).pipe(Effect.ignore)
    yield* input.fsys.remove(path.join(dir, `${label(input.id)}.service`)).pipe(Effect.ignore)
    yield* input.fsys.remove(timer).pipe(Effect.ignore)
    return
  }
})

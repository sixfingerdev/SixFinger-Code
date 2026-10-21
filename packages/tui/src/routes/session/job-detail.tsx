import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { ToolPart } from "@sixfinger/sdk/v2"
import stripAnsi from "strip-ansi"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"
import { formatClock, friendlyJobText, stripJobIds, useClockTick } from "./activity-jobs"

export type JobDetailInput = {
  kind: "bash" | "monitor" | "wakeup" | "sleep" | "jobs"
  part: ToolPart
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
}

const [detail, setDetail] = createSignal<JobDetailInput | null>(null)

/** Open the bottom detail panel for a job; clicking the same line again closes it. */
export function showJobDetail(value: JobDetailInput) {
  setDetail((current) =>
    current?.part.callID === value.part.callID && current.kind === value.kind ? null : value,
  )
}

function str(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function num(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function JobDetailPanel() {
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const dimensions = useTerminalDimensions()
  const active = () => detail() !== null
  const tick = useClockTick(active)

  useBindings(() => ({
    enabled: detail() !== null,
    bindings: [
      {
        key: "escape",
        desc: "Close job details",
        group: "Job details",
        cmd: () => setDetail(null),
      },
    ],
  }))

  // The tool part completes in milliseconds for backgrounded work, so its own
  // timestamps say nothing about the job. The real end (state + completed_at
  // + result) is in the completion marker the tool injects when it settles.
  const completion = createMemo(() => {
    const current = detail()
    if (!current || (current.kind !== "bash" && current.kind !== "monitor")) return undefined
    const jobId = str(current.metadata, "jobId")
    if (!jobId) return undefined
    const escaped = jobId.replace(/[^a-zA-Z0-9_]/g, "")
    const pattern = new RegExp(
      `<background_job id="${escaped}" state="(completed|error|cancelled)"[^>]*?completed_at="(\\d+)"[\\s\\S]*?<result>([\\s\\S]*?)</result>`,
    )
    const messages = sync.data.message[current.part.sessionID] ?? []
    for (const message of messages) {
      for (const part of sync.data.part[message.id] ?? []) {
        if (part.type !== "text" || !part.text) continue
        const match = part.text.match(pattern)
        if (match) return { state: match[1], completedAt: Number(match[2]), result: match[3]?.trim() ?? "" }
      }
    }
    return undefined
  })

  // Live output for running bash/monitor jobs. The transcript only holds the
  // snapshot from launch time, so while the job runs the panel polls the
  // server for the current output tail. Once the completion marker lands in
  // the transcript, polling stops and the final result takes over.
  type LiveJob = { status: string; output: string; gone: boolean }
  const [live, setLive] = createSignal<LiveJob | null>(null)

  const liveJobId = () => {
    const current = detail()
    if (!current || (current.kind !== "bash" && current.kind !== "monitor")) return undefined
    if (completion() !== undefined) return undefined
    return str(current.metadata, "jobId")
  }

  let inflight = false
  let liveKey: string | undefined
  createEffect(() => {
    const current = detail()
    tick()
    const key = current ? `${current.kind}:${current.part.callID}` : undefined
    if (key !== liveKey) {
      liveKey = key
      setLive(null)
    }
    const id = liveJobId()
    if (!id || inflight) return
    inflight = true
    sdk.client.experimental.background
      .get({ jobID: id, workspace: project.workspace.current() })
      .then((result) => {
        if (key !== liveKey) return
        if (result.data) setLive({ status: result.data.status, output: result.data.output, gone: false })
        else setLive({ status: "", output: "", gone: true })
      })
      .catch(() => {
        if (key === liveKey) setLive({ status: "", output: "", gone: true })
      })
      .finally(() => {
        inflight = false
      })
  })

  const title = () => {
    switch (detail()?.kind) {
      case "monitor":
        return "Monitor details"
      case "wakeup":
        return "Wakeup details"
      case "sleep":
        return "Sleep details"
      case "jobs":
        return "Background jobs"
      default:
        return "Shell details"
    }
  }

  const status = () => {
    const current = detail()
    if (!current) return ""
    tick()
    const state = current.part.state
    const activity = rec(current.metadata.activity)
    const time = "time" in state ? (state.time as { start?: unknown; end?: unknown } | undefined) : undefined
    const start = num(current.metadata, "started_at") ?? (typeof time?.start === "number" ? time.start : Date.now())
    const end = typeof time?.end === "number" ? time.end : undefined
    const elapsed = Locale.duration((end ?? Date.now()) - start)
    const running = state.status === "running"
    const done = completion()
    // Backgrounded bash/monitor tool parts complete the moment the job is
    // parked; without a completion marker the job itself is still live.
    const stillRunning =
      running ||
      (done === undefined && (current.kind === "bash" || current.kind === "monitor") && state.status !== "error")
    if (current.kind === "monitor") {
      const deadline = num(activity, "deadline") ?? num(current.metadata, "deadline")
      if (state.status === "error") return `failed after ${elapsed}`
      if (!stillRunning) {
        if (!done) return "stopped"
        const actual = Locale.duration(done.completedAt - start)
        return done.state === "error" ? `failed · ran for ${actual}` : `finished · ran for ${actual}`
      }
      if (deadline === undefined) return `listening · ${elapsed}`
      const remaining = deadline - Date.now()
      return remaining <= 0 ? "listening" : `listening · ${Locale.duration(remaining)} left`
    }
    if (current.kind === "wakeup") {
      const deadline = num(activity, "deadline") ?? num(current.metadata, "deadline")
      if (deadline !== undefined && deadline > Date.now()) {
        const remaining = deadline - Date.now()
        return remaining <= 0 ? "firing" : `wakes in ${Locale.duration(remaining)}`
      }
      if (state.status === "error") return `failed after ${elapsed}`
      return `done · ${elapsed}`
    }
    if (current.kind === "sleep") {
      const until = num(current.metadata, "until") ?? num(activity, "until")
      if (running && until !== undefined) {
        const remaining = until - Date.now()
        return remaining <= 0 ? "waking" : `${Locale.duration(remaining)} left`
      }
      if (state.status === "error") return `interrupted after ${elapsed}`
      return current.metadata.interrupted === true ? `interrupted after ${elapsed}` : `slept ${elapsed}`
    }
    if (state.status === "error") return `failed after ${elapsed}`
    if (!stillRunning) {
      if (!done) return "finished"
      const actual = Locale.duration(done.completedAt - start)
      if (done.state === "error") return `failed · ran for ${actual}`
      if (done.state === "cancelled") return `cancelled after ${actual}`
      return `finished · ran for ${actual}`
    }
    const liveState = live()
    if (liveState && !liveState.gone) return `running for ${elapsed} · live`
    return `running for ${elapsed}`
  }

  const command = () => {
    const current = detail()
    if (!current) return undefined
    if (current.kind === "bash") return str(current.input, "command") ?? str(current.metadata, "command")
    if (current.kind === "monitor") {
      const command = str(current.input, "command")
      if (command) return command
      const url = str(rec(current.input.ws), "url")
      if (url) return `websocket: ${url}`
      const mcp = rec(current.input.mcp)
      if (mcp) return `mcp: ${str(mcp, "server") ?? "?"}/${str(mcp, "tool") ?? "?"}`
      return undefined
    }
    return undefined
  }

  const metaLines = () => {
    const current = detail()
    if (!current) return []
    const lines: string[] = []
    const start =
      num(current.metadata, "started_at") ??
      ("time" in current.part.state && typeof current.part.state.time?.start === "number"
        ? current.part.state.time.start
        : Date.now())
    lines.push(`started ${formatClock(start)}`)
    lines.push(status())
    const note = str(current.input, "note")
    if (current.kind === "wakeup" && note) lines.push(`note: ${note}`)
    return lines
  }

  const body = () => {
    const current = detail()
    if (!current) return ""
    const done = completion()
    // While the job runs, the panel shows live output from the server or the
    // runner's rolling preview. The launch blurb ("started in the
    // background") is redundant with the command and status lines above.
    if (!done && (current.kind === "bash" || current.kind === "monitor")) {
      const liveState = live()
      const raw = stripAnsi(
        liveState && !liveState.gone && liveState.output.trim() ? liveState.output : str(current.metadata, "output") ?? "",
      )
      const text =
        current.kind === "monitor"
          ? raw.replace(/<\/?background_job[^>]*>/g, "").replace(/<monitor_event[^>]*>|<\/monitor_event>/g, "").trim()
          : friendlyJobText(raw)
          .replace(/^▣ .*\n?/m, "")
          .trim()
      return stripJobIds(text || "(no output yet)")
    }
    if (done) {
      const result = done.result.trim()
      return stripJobIds(result || "(no output)")
    }
    // Prefer the user-facing text: model instructions and job ids never
    // belong on screen. Fall back to the legacy shapes when missing.
    const userOutput = str(current.metadata, "userOutput")
    if (userOutput !== undefined) return stripJobIds(userOutput.trim() || "(no output yet)")
    if (current.kind === "jobs") return stripJobIds(stripAnsi(current.output?.trim() ?? "")) || "(no output)"
    const raw = stripAnsi(str(current.metadata, "output") ?? current.output ?? "")
    const text = current.kind === "monitor" ? raw.replace(/<\/?background_job[^>]*>/g, "").trim() : friendlyJobText(raw)
    return stripJobIds(text.trim() || "(no output yet)")
  }

  const outputPath = () => {
    const current = detail()
    return current ? str(current.metadata, "outputPath") : undefined
  }

  return (
    <Show when={detail()}>
      <box
        position="absolute"
        left={0}
        right={0}
        bottom={0}
        height={Math.max(8, Math.floor((dimensions().height * 7) / 16))}
        backgroundColor={theme.backgroundPanel}
        border={["top"]}
        paddingLeft={2}
        paddingRight={2}
      >
        <box flexShrink={0} flexDirection="row" gap={1}>
          <text fg={theme.primary}>
            <b>{title()}</b>
          </text>
          <text fg={theme.textMuted}>esc to close</text>
        </box>
        <Show when={command()}>
          <text flexShrink={0} fg={theme.text}>
            $ {command()}
          </text>
        </Show>
        <box flexShrink={0} flexDirection="row" gap={1}>
          {metaLines().map((line) => (
            <text flexShrink={0} fg={theme.textMuted}>
              {line} ·
            </text>
          ))}
        </box>
        <Show when={outputPath()}>
          <text flexShrink={0} fg={theme.textMuted}>
            output file: {outputPath()}
          </text>
        </Show>
        <scrollbox flexGrow={1} paddingTop={1}>
          <text fg={theme.text} wrapMode="word">
            {body()}
          </text>
        </scrollbox>
      </box>
    </Show>
  )
}

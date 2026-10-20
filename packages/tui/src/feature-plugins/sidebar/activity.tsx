import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { formatClock, scanActivityJobs } from "../../routes/session/activity-jobs"
import { showJobDetail } from "../../routes/session/job-detail"

const id = "internal:sidebar-activity"

function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  // Re-evaluate every second so elapsed/remaining times stay live; cleared on
  // unmount. The scan itself only recomputes when messages/parts change.
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  onCleanup(() => clearInterval(timer))
  const [hovered, setHovered] = createSignal<string | undefined>()

  const scanned = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    if (messages.length === 0) return []
    return scanActivityJobs(messages, (messageID) => props.api.state.part(messageID))
  })

  const jobs = createMemo(() => {
    tick()
    const now = Date.now()
    return scanned().map((job) => {
      const elapsed = duration(now - job.startedAt)
      const status =
        job.kind === "monitor"
          ? job.deadline === undefined
            ? `listening · ${elapsed}`
            : job.deadline <= now
              ? `listening · ${elapsed}`
              : `${duration(job.deadline - now)} left`
          : job.kind === "wakeup"
            ? job.deadline !== undefined && job.deadline > now
              ? `in ${duration(job.deadline - now)}`
              : "firing"
            : job.kind === "sleep"
              ? job.deadline !== undefined && job.deadline > now
                ? `${duration(job.deadline - now)} left`
                : elapsed
              : elapsed
      return { ...job, key: job.id, status }
    })
  })

  const color = (kind: string) =>
    kind === "bash" ? theme().success : kind === "monitor" ? theme().primary : theme().warning

  return (
    <Show when={jobs().length > 0}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>Activity</b>
          </text>
          <Show when={jobs().length > 1}>
            <text fg={theme().textMuted}>{jobs().length}</text>
          </Show>
        </box>
        <For each={jobs()}>
          {(job) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={hovered() === job.key ? theme().backgroundMenu : undefined}
              onMouseOver={() => setHovered(job.key)}
              onMouseOut={() => setHovered(undefined)}
              onMouseUp={() => {
                if (!job.source) return
                showJobDetail({
                  kind: job.kind,
                  part: job.source.part,
                  input: job.source.input,
                  metadata: job.source.metadata,
                  output: job.source.output,
                })
              }}
            >
              <text flexShrink={0} style={{ fg: color(job.kind) }}>
                {job.icon}
              </text>
              <text fg={theme().text} wrapMode="none">
                {job.title}{" "}
                <span style={{ fg: theme().textMuted }}>{job.status}</span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

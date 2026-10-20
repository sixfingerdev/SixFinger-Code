import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { InstanceState } from "@/effect/instance-state"
import { Cron } from "@/session/cron"

/**
 * In-app cron firing. Each enabled entry owned by this instance's directory
 * gets a per-entry fiber (a background job keyed by entry id): sleep until
 * nextRun, inject the prompt into the target session, advance the entry,
 * repeat. The fiber dies with the process or on cron_delete; the OS scheduler
 * covers the closed case for os-scheduled entries.
 *
 * These are plain functions, not a LayerNode service: the arming caller is the
 * instance bootstrap, which sits upstream of SessionPrompt in the layer graph.
 * A static dependency here would create a LayerNode cycle and deadlock boot.
 */

export const fireText = (entry: Cron.Entry, firedAt: number) =>
  [
    `<cron id="${entry.id}" name="${entry.name}" fired_at="${firedAt}">`,
    entry.prompt,
    `This is a scheduled firing, not a user message. Stop it with cron_delete (id "${entry.id}").`,
    `</cron>`,
  ].join("\n")

export const arm = Effect.fn("CronScheduler.arm")(function* (input: {
  fsys: FSUtil.Interface
  background: BackgroundJob.Interface
  sessions: Session.Interface
  fire: (input: { sessionID: SessionID; entry: Cron.Entry; firedAt: number }) => Effect.Effect<void>
  id: string
  fallbackParentID?: SessionID
}) {
  const firing = Effect.gen(function* () {
    while (true) {
      const current = yield* Cron.get({ fsys: input.fsys, id: input.id })
      if (!current || !current.enabled) return
      const delay = Math.max(0, current.nextRun - Date.now())
      yield* Effect.sleep(`${delay} millis`)
      const target =
        current.session === "existing" && current.sessionID
          ? SessionID.make(current.sessionID)
          : (yield* input.sessions.create({ parentID: input.fallbackParentID, title: `cron: ${current.name}` })).id
      yield* input.fire({ sessionID: target, entry: current, firedAt: Date.now() })
      const advanced = yield* Cron.markRun({ fsys: input.fsys, id: input.id, now: Date.now() })
      if (!advanced) return
    }
  })
  yield* input.background.start({ id: input.id, type: "cron", title: "cron", run: firing.pipe(Effect.as("armed")) })
})

/** Arm every enabled entry owned by the current instance's directory. Uses
 * serviceOption so callers without the full app runtime (narrow test runtimes)
 * skip silently instead of failing bootstrap. */
export const armAll = Effect.fn("CronScheduler.armAll")(function* () {
  const fsys = Option.getOrUndefined(yield* Effect.serviceOption(FSUtil.Service))
  const background = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
  const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
  const prompter = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
  if (!fsys || !background || !sessions || !prompter) return

  // Overdue entries missed while away fire immediately on arm; they are
  // reported here instead of silently catching up multiple periods.
  const ctx = yield* InstanceState.context
  const entries = yield* Cron.list({ fsys })
  const owned = entries.filter((entry) => entry.enabled && entry.directory === ctx.directory)
  const missed = owned.filter((entry) => entry.nextRun <= Date.now())
  if (missed.length > 0) {
    yield* Effect.logWarning("cron missed runs while away, firing on catch-up", {
      count: missed.length,
      ids: missed.map((entry) => entry.id),
    })
  }
  for (const entry of owned) {
    yield* arm({
      fsys,
      background,
      sessions,
      id: entry.id,
      fire: ({ sessionID, entry, firedAt }) =>
        prompter
          .prompt({ sessionID, parts: [{ type: "text", synthetic: true, text: fireText(entry, firedAt) }] })
          .pipe(Effect.ignore),
    }).pipe(Effect.ignore)
  }
})

export * as CronScheduler from "./cron-scheduler"

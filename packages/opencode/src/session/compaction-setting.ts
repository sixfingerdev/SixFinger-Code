import { CompactionWindow } from "@opencode-ai/core/session/window"
import { Global } from "@opencode-ai/core/global"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs"
import path from "path"

const WindowSchema = Schema.Union([
  Schema.Literals(["auto-low", "auto-medium", "auto-max"]),
  Schema.Finite,
])

const StateSchema = Schema.Struct({
  window: WindowSchema,
})

const file = () => path.join(Global.Path.state, "compaction.json")

let current: CompactionWindow.Window = CompactionWindow.DEFAULT

export function get(): CompactionWindow.Window {
  return current
}

/** Read the persisted window at boot. Synchronous and dependency-free on
 * purpose: the config handler layer has no FSUtil, and this runs once. */
export function load(): CompactionWindow.Window {
  try {
    const raw = fs.readFileSync(file(), "utf8")
    const parsed = Schema.decodeUnknownExit(StateSchema)(JSON.parse(raw))
    if (Exit.isSuccess(parsed)) current = parsed.value.window
  } catch {
    // Missing or malformed state file keeps the default.
  }
  return current
}

export const set = (window: CompactionWindow.Window) =>
  Effect.gen(function* () {
    current = window
    yield* Effect.tryPromise({
      try: async () => {
        await fs.promises.mkdir(path.dirname(file()), { recursive: true })
        await fs.promises.writeFile(file(), JSON.stringify({ window }, null, 2))
      },
      catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
    })
    return current
  })

export const schema = WindowSchema

export * as CompactionSetting from "./compaction-setting"

import { Cause, Effect } from "effect"
import { spawn } from "node:child_process"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Cron } from "@/session/cron"
import { selfBinary } from "@/session/cron-os"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { cmd } from "./cmd"

const toCliError = (error: unknown) =>
  error instanceof CliError ? Effect.fail(error) : fail(error instanceof Error ? error.message : String(error))

const spawnRun = (args: string[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(args[0]!, args.slice(1), { stdio: "inherit" })
        child.on("error", reject)
        child.on("close", (code: number | null) => resolve(code ?? 1))
      }),
    catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
  })

export const CronRunCommand = effectCmd({
  command: "run",
  describe: "run one due cron entry headlessly (invoked by the OS scheduler)",
  instance: false,
  builder: (yargs) =>
    yargs.option("due", {
      describe: "cron entry id whose time has come",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.cron.run")(function* (args) {
    return yield* Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const entry = yield* Cron.get({ fsys, id: args.due })
      if (!entry) return yield* fail(`Unknown cron: "${args.due}".`)
      if (!entry.enabled) return yield* fail(`Cron "${args.due}" is disabled.`)
      const dirArgs = entry.directory ? ["--dir", entry.directory] : []
      const runArgs =
        entry.session === "existing" && entry.sessionID
          ? [...selfBinary(), "run", entry.prompt, "--session", entry.sessionID, ...dirArgs]
          : [...selfBinary(), "run", entry.prompt, ...dirArgs]
      const code = yield* spawnRun(runArgs)
      yield* Cron.markRun({ fsys, id: entry.id, now: Date.now() })
      if (code !== 0) return yield* fail(`Cron run exited with code ${code}.`, code)
    }).pipe(
      Effect.catchCause((cause) => toCliError(Cause.squash(cause))),
    )
  }),
})

export const CronListCommand = effectCmd({
  command: "list",
  describe: "list scheduled tasks",
  instance: false,
  handler: Effect.fn("Cli.cron.list")(function* () {
    return yield* Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const entries = yield* Cron.list({ fsys })
      if (entries.length === 0) {
        console.log("No scheduled tasks.")
        return
      }
      for (const entry of entries) console.log(Cron.describe(entry))
    }).pipe(Effect.catchCause((cause) => toCliError(Cause.squash(cause))))
  }),
})

export const CronRemoveCommand = effectCmd({
  command: "remove <id>",
  describe: "delete a scheduled task",
  instance: false,
  builder: (yargs) => yargs.positional("id", { describe: "cron entry id", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cron.remove")(function* (args) {
    return yield* Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      const { unregisterOS } = yield* Effect.promise(() => import("@/session/cron-os"))
      const entry = yield* Cron.get({ fsys, id: args.id })
      if (entry?.osScheduled === true) {
        yield* unregisterOS({ fsys, id: entry.id }).pipe(Effect.ignore)
      }
      const ok = yield* Cron.remove({ fsys, id: args.id })
      if (!ok) return yield* fail(`Unknown cron: "${args.id}".`)
      console.log(`Deleted cron ${args.id}.`)
    }).pipe(Effect.catchCause((cause) => toCliError(Cause.squash(cause))))
  }),
})

export const CronCommand = cmd({
  command: "cron",
  describe: "manage scheduled tasks",
  builder: (yargs) => yargs.command(CronRunCommand).command(CronListCommand).command(CronRemoveCommand).demandCommand(),
  async handler() {},
})

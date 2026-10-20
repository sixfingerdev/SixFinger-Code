import { Deferred, Effect, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { Identifier } from "@opencode-ai/core/id/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "./task"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const AUTO_BACKGROUND_MS = 60_000

// Progress wakes: how often the watcher polls the registry, the minimum gap
// between two wakes for the same job, and how much output a wake carries.
const PROGRESS_POLL_MS = 5_000
const PROGRESS_WAKE_MS = 30_000
const PROGRESS_TAIL_CHARS = 2000

function clock(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false })
}

function elapsed(since: number) {
  return duration(Date.now() - since)
}

function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`
}

type ShellEnvelope = {
  output: string
  last: string
  exit: number | null
  truncated: boolean
  outputPath?: string
  expired: boolean
  aborted: boolean
}

function renderBackgroundStart(input: {
  id: string
  command: string
  started_at: number
  outputPath?: string
  auto: boolean
}) {
  const where = input.outputPath ? `Output file: ${input.outputPath} (use Read to inspect while it runs)` : `Output is captured and will be attached when it finishes`
  return [
    `<background_job id="${input.id}" state="running" started_at="${input.started_at}">`,
    input.auto
      ? `Command "${input.command}" is still running after 60s, so it was moved to the background with ID ${input.id}. It keeps running; the session stays responsive.`
      : `Command "${input.command}" started in the background with ID ${input.id}.`,
    `Started at ${clock(input.started_at)}, running for ${elapsed(input.started_at)}.`,
    `You will be notified automatically when it finishes. DO NOT poll, sleep-wait, or duplicate this work.`,
    where,
    `To stop it, use the background tool with action "stop" and job_id "${input.id}".`,
    `</background_job>`,
  ].join("\n")
}

function renderBackgroundDone(input: {
  id: string
  command: string
  state: "completed" | "error" | "cancelled"
  started_at: number
  completed_at: number
  summary: string
  outputPath?: string
}) {
  const label = input.state === "completed" ? "finished" : input.state === "error" ? "failed" : "was cancelled"
  return [
    `<background_job id="${input.id}" state="${input.state}" started_at="${input.started_at}" completed_at="${input.completed_at}">`,
    `Background command "${input.command}" ${label}. Started at ${clock(input.started_at)}, ran for ${duration(input.completed_at - input.started_at)}.`,
    ...(input.outputPath ? [`Full output saved to: ${input.outputPath}`] : []),
    `<result>`,
    input.summary,
    `</result>`,
    `</background_job>`,
  ].join("\n")
}

function renderBackgroundProgress(input: {
  id: string
  command: string
  started_at: number
  tail: string
}) {
  return [
    `<background_job id="${input.id}" state="progress" started_at="${input.started_at}">`,
    `Background command "${input.command}" is still running. New output since your last look:`,
    input.tail,
    `It keeps running in the background; you will be notified when it finishes. Stop it early with the background tool (action stop) if it is misbehaving.`,
    `</background_job>`,
  ].join("\n")
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout?: number
        // Foreground runs listen for the tool abort signal (user Esc) until the
        // tool detaches them (60s auto-background boundary). Detached runs -
        // explicit background jobs - ignore ctx.abort entirely, because the AI
        // SDK aborts that signal as soon as the tool call completes.
        detach?: Deferred.Deferred<void>
        jobID: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
          // The process must outlive the tool call (background jobs keep running after
          // this returns), so interruption - not the tool abort signal - is what kills
          // it: scope close, background.cancel, or session teardown.
          yield* Effect.addFinalizer(() => handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              // Publish the chunk to the background job registry so the TUI can
              // show live output while the job runs; ignored after settle.
              const publish = background.report(input.jobID, chunk).pipe(Effect.ignore)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return publish.pipe(
                    Effect.andThen(
                      trunc.write(full).pipe(
                        Effect.andThen((next) =>
                          Effect.sync(() => {
                            file = next
                            cut = true
                            sink = createWriteStream(next, { flags: "a" })
                            full = ""
                          }),
                        ),
                        Effect.andThen(
                          ctx.metadata({
                            metadata: {
                              output: last,
                            },
                          }),
                        ),
                      ),
                    ),
                  )
                }
              }

              return publish.pipe(
                Effect.andThen(
                  ctx.metadata({
                    metadata: {
                      output: last,
                    },
                  }),
                ),
              )
            }),
          )

          let abortRacer: Effect.Effect<{ kind: "abort"; code: number | null }> | undefined
          if (input.detach !== undefined) {
            const abortedFlag = yield* Deferred.make<void>()
            const detach = input.detach
            yield* Effect.forkScoped(
              Effect.raceFirst(
                Effect.callback<void>((resume) => {
                  if (ctx.abort.aborted) return resume(Effect.void)
                  const handler = () => resume(Effect.void)
                  ctx.abort.addEventListener("abort", handler, { once: true })
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
                }).pipe(Effect.map(() => "abort" as const)),
                Deferred.await(detach).pipe(Effect.map(() => "detach" as const)),
              ).pipe(
                Effect.flatMap((which) =>
                  which === "abort" ? Deferred.succeed(abortedFlag, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
              ),
            )
            abortRacer = Deferred.await(abortedFlag).pipe(
              Effect.map(() => ({ kind: "abort" as const, code: null as number | null })),
            )
          }

          const racers = [
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code: code as number | null }))),
            ...(abortRacer ? [abortRacer] : []),
            ...(input.timeout === undefined
              ? []
              : [
                  Effect.sleep(`${input.timeout + 100} millis`).pipe(
                    Effect.map(() => ({ kind: "timeout" as const, code: null as number | null })),
                  ),
                ]),
          ]

          const exit = yield* Effect.raceAll(racers)

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired && input.timeout !== undefined) {
        meta.push(
          `shell tool terminated command after exceeding the confirmed timeout ${input.timeout} ms.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          expired,
          aborted,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    const decodeEnvelope = (raw: string | undefined): ShellEnvelope | undefined => {
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as Partial<ShellEnvelope>
        if (typeof parsed.output !== "string") return
        return {
          output: parsed.output,
          last: typeof parsed.last === "string" ? parsed.last : parsed.output,
          exit: typeof parsed.exit === "number" ? parsed.exit : null,
          truncated: parsed.truncated === true,
          ...(typeof parsed.outputPath === "string" ? { outputPath: parsed.outputPath } : {}),
          expired: parsed.expired === true,
          aborted: parsed.aborted === true,
        }
      } catch {
        return
      }
    }

    const injectBackgroundResult = Effect.fn("ShellTool.injectBackgroundResult")(function* (
      jobID: string,
      command: string,
      started_at: number,
      state: "completed" | "error" | "cancelled",
      summary: string,
      outputPath: string | undefined,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      const text = renderBackgroundDone({
        id: jobID,
        command,
        state,
        started_at,
        completed_at: Date.now(),
        summary,
        ...(outputPath ? { outputPath } : {}),
      })
      yield* ops
        .prompt({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          parts: [{ type: "text", synthetic: true, text }],
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    const notify = Effect.fn("ShellTool.notifyBackgroundResult")(function* (
      jobID: string,
      command: string,
      started_at: number,
      ctx: Tool.Context,
    ) {
      const waited = yield* background.wait({ id: jobID })
      const envelope = decodeEnvelope(waited.info?.output)
      const state =
        !waited.info || waited.info.status === "cancelled" || envelope?.aborted
          ? ("cancelled" as const)
          : envelope?.expired || (envelope && envelope.exit !== 0)
            ? ("error" as const)
            : ("completed" as const)
      const raw = envelope?.output ?? waited.info?.error ?? "(no output)"
      const summary = raw.length > 4000 ? `...truncated...\n\n${raw.slice(-4000)}` : raw
      yield* injectBackgroundResult(jobID, command, started_at, state, summary, envelope?.outputPath, ctx)
    })

    // While a background job runs, wake the model when its output changes so
    // it can react to progress instead of waiting for completion. Poll the
    // registry, and throttle wakes: at most one per window, and a change that
    // lands during the window is remembered and wakes when it opens.
    const watchProgress = Effect.fn("ShellTool.watchProgress")(function* (
      jobID: string,
      command: string,
      started_at: number,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      let seen = ""
      let lastWake = 0
      while (true) {
        yield* Effect.sleep(`${PROGRESS_POLL_MS} millis`)
        const info = yield* background.get(jobID)
        if (!info || info.status !== "running") return
        const text = info.progress ?? ""
        if (text === seen || Date.now() - lastWake < PROGRESS_WAKE_MS) continue
        seen = text
        lastWake = Date.now()
        const tail = text.length > PROGRESS_TAIL_CHARS ? `...truncated...\n${text.slice(-PROGRESS_TAIL_CHARS)}` : text
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderBackgroundProgress({ id: jobID, command, started_at, tail }),
              },
            ],
          })
          .pipe(Effect.ignore)
      }
    })

    const backgroundStarted = (input: {
      id: string
      command: string
      started_at: number
      outputPath?: string
      auto: boolean
    }) => ({
      title: input.command,
      metadata: {
        output: renderBackgroundStart(input),
        userOutput: input.auto
          ? `Moved to the background after 60s · started ${clock(input.started_at)}`
          : `Started ${clock(input.started_at)}`,
        background: true,
        jobId: input.id,
        started_at: input.started_at,
        ...(input.outputPath ? { outputPath: input.outputPath } : {}),
        activity: { kind: "bash" as const, id: input.id, command: input.command, started_at: input.started_at },
      },
      output: renderBackgroundStart(input),
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              if (params.timeout !== undefined && params.confirm_timeout !== true) {
                throw new Error(
                  [
                    `There is no default timeout: commands run until they finish.`,
                    `You requested timeout ${params.timeout} ms for "${params.command}".`,
                    `If you are sure the command should be killed after ${params.timeout} ms, re-issue the same call with confirm_timeout=true.`,
                    `Otherwise drop the timeout parameter; commands running longer than 60 seconds move to the background automatically and notify you on completion.`,
                  ].join(" "),
                )
              }
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              const env = yield* shellEnv(ctx, cwd)
              const detached = params.background === true
              const detach = yield* Deferred.make<void>()
              const jobID = Identifier.ascending("job")
              const jobBody = run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env,
                  timeout: params.timeout,
                  jobID,
                  ...(detached ? {} : { detach }),
                },
                ctx,
              ).pipe(
                Effect.map((result) =>
                  JSON.stringify({
                    output: result.output,
                    last: result.metadata.output,
                    exit: result.metadata.exit,
                    truncated: result.metadata.truncated,
                    ...(result.metadata.outputPath ? { outputPath: result.metadata.outputPath } : {}),
                    expired: result.metadata.expired,
                    aborted: result.metadata.aborted,
                  } satisfies ShellEnvelope),
                ),
              )
              const info = yield* background.start({
                id: jobID,
                type: ShellID.ToolID,
                title: params.command,
                metadata: { command: params.command, cwd, sessionID: ctx.sessionID, background: true },
                run: jobBody,
              })
              const started_at = info.started_at
              if (params.background === true) {
                yield* Effect.all(
                  [
                    notify(info.id, params.command, started_at, ctx),
                    watchProgress(info.id, params.command, started_at, ctx),
                  ],
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.forkIn(scope, { startImmediately: true }))
                return backgroundStarted({ id: info.id, command: params.command, started_at, auto: false })
              }
              const waited = yield* background.wait({ id: info.id, timeout: AUTO_BACKGROUND_MS }).pipe(
                Effect.onInterrupt(() => background.cancel(info.id).pipe(Effect.ignore)),
              )
              if (waited.timedOut) {
                // Detach before returning: the AI SDK aborts the tool signal when this
                // call completes, and the auto-backgrounded job must survive that.
                yield* Deferred.succeed(detach, undefined).pipe(Effect.ignore)
                yield* Effect.all(
                  [
                    notify(info.id, params.command, started_at, ctx),
                    watchProgress(info.id, params.command, started_at, ctx),
                  ],
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.forkIn(scope, { startImmediately: true }))
                return backgroundStarted({ id: info.id, command: params.command, started_at, auto: true })
              }
              const envelope = decodeEnvelope(waited.info?.output)
              if (!envelope) {
                const fallback = waited.info?.error ?? "(no output)"
                return {
                  title: params.command,
                  metadata: {
                    output: fallback,
                    userOutput: fallback,
                    background: false as const,
                    jobId: info.id,
                    started_at,
                    activity: {
                      kind: "bash" as const,
                      id: info.id,
                      command: params.command,
                      started_at,
                    },
                  },
                  output: fallback,
                }
              }
              return {
                title: params.command,
                metadata: {
                  output: envelope.last,
                  userOutput: envelope.output,
                  exit: envelope.exit,
                  truncated: envelope.truncated,
                  ...(envelope.outputPath ? { outputPath: envelope.outputPath } : {}),
                  background: false as const,
                  jobId: info.id,
                  started_at,
                  activity: {
                    kind: "bash" as const,
                    id: info.id,
                    command: params.command,
                    started_at,
                  },
                },
                output: envelope.output,
              }
            }),
        }
      })
  }),
)

import { Cause, Deferred, Effect, Schema, Scope, Stream } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@sixfinger/core/schema"
import { Identifier } from "@sixfinger/core/id/id"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { Shell } from "@sixfinger/core/shell"
import { ShellID } from "./shell/id"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "./task"

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 3_600_000
const BATCH_MS = 200
const MAX_EVENTS = 100
const MAX_STDERR_BYTES = 100 * 1024
const DEFAULT_MCP_POLL_MS = 10_000
const MIN_MCP_POLL_MS = 1_000
const MAX_MCP_POLL_MS = 60_000
const MAX_MCP_EVENT_CHARS = 4_000

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({
    description: "Short label shown in every notification (for example: errors in deploy.log).",
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "Shell command whose stdout is the event stream. Each output line becomes one notification. Exactly one of command, ws, or mcp is required. Pipe through grep --line-buffered to filter before monitoring.",
  }),
  ws: Schema.optional(
    Schema.Struct({
      url: Schema.String.annotate({ description: "ws:// or wss:// endpoint to connect to." }),
      protocols: Schema.optional(Schema.Array(Schema.String)).annotate({
        description: "WebSocket subprotocol names to offer during the handshake.",
      }),
    }),
  ).annotate({
    description: "Connect to a WebSocket feed and treat each message as an event. Cannot be combined with command or mcp.",
  }),
  mcp: Schema.optional(
    Schema.Struct({
      server: Schema.String.annotate({ description: "MCP server name as configured." }),
      tool: Schema.String.annotate({ description: "Tool name on that server (without the server prefix)." }),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
        description: "Static arguments passed on every poll.",
      }),
      poll_ms: Schema.optional(PositiveInt).annotate({
        description:
          "How often to call the tool. Default 10000 (10s), minimum 1000, maximum 60000. The first call is a baseline; each change afterwards wakes you with the new output.",
      }),
    }),
  ).annotate({
    description:
      "Poll an MCP tool (for example one that returns unread messages) and wake you whenever its output changes. Cannot be combined with command or ws.",
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Stop the monitor after this many milliseconds. Default 300000 (5 minutes), maximum 3600000 (1 hour).",
  }),
  persistent: Schema.optional(Schema.Boolean).annotate({
    description: "When true, the monitor runs until the session ends or it is stopped. Overrides timeout_ms.",
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

function validateUrl(url: string) {
  if (!/^wss?:\/\/[^\s]+$/.test(url)) return "URL must be a ws:// or wss:// URL without whitespace."
  if (!/^[\x00-\x7F]*$/.test(url)) return "URL must use ASCII characters only."
  const authority = url.replace(/^wss?:\/\//, "").split("/")[0] ?? ""
  if (authority.includes("@")) return "URL must not contain embedded credentials."
  return
}

export const MonitorTool = Tool.define(
  "monitor",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const mcp = yield* MCP.Service
    const background = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope

    // Calls the monitored MCP tool once and returns its text content; mirrors
    // McpCatalog.convertTool's transport handling without the AI-tool wrapper.
    const callMcpTool = Effect.fn("MonitorTool.callMcpTool")(function* (input: {
      server: string
      tool: string
      arguments?: Record<string, unknown>
    }) {
      const key = McpCatalog.toolName(input.server, input.tool)
      const entry = (yield* mcp.tools())[key]
      if (!entry) return yield* Effect.fail(new Error(`Unknown MCP tool: "${key}".`))
      const result = yield* Effect.tryPromise({
        try: () =>
          entry.client.callTool(
            { name: entry.def.name, arguments: input.arguments ?? {} },
            CallToolResultSchema,
            { resetTimeoutOnProgress: true, timeout: entry.timeout, onprogress: () => {} },
          ),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).filter((part) => part.trim()).join("\n")
      if (result.isError) {
        return yield* Effect.fail(new Error(text || "MCP tool returned an error"))
      }
      if (!text && result.structuredContent !== undefined && result.structuredContent !== null) {
        return JSON.stringify(result.structuredContent)
      }
      return text
    })

    const inject = Effect.fn("MonitorTool.inject")(function* (
      text: string,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      yield* ops
        .prompt({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          parts: [{ type: "text", synthetic: true, text }],
        })
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
    })

    const renderEvent = (jobID: string, description: string, started_at: number, count: number, lines: string[]) =>
      [
        `<monitor_event id="${jobID}" description="${description}" elapsed="${duration(Date.now() - started_at)}" lines="${count}">`,
        ...lines,
        `</monitor_event>`,
      ].join("\n")

    const renderEnd = (input: {
      id: string
      description: string
      started_at: number
      completed_at: number
      reason: string
      eventCount: number
      outputPath?: string
    }) =>
      [
        `<background_job id="${input.id}" state="completed" started_at="${input.started_at}" completed_at="${input.completed_at}">`,
        `Monitor "${input.description}" stopped after ${duration(input.completed_at - input.started_at)}: ${input.reason}. Delivered ${input.eventCount} events.`,
        ...(input.outputPath ? [`Stderr saved to: ${input.outputPath}`] : []),
        `</background_job>`,
      ].join("\n")

    const watchCommand = Effect.fn("MonitorTool.watchCommand")(function* (input: {
      shell: string
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
      jobID: string
      description: string
      started_at: number
      timeoutMs: number
      persistent: boolean
      ctx: Tool.Context
    }) {
      const queue: string[] = []
      const errChunks: string[] = []
      let errBytes = 0
      let buffer = ""
      let events = 0
      let stopped = false
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(input.command, [], {
              shell: input.shell,
              cwd: input.cwd,
              env: input.env,
              stdin: "ignore",
              detached: process.platform !== "win32",
            }),
          )
          const kill = handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie, Effect.ignore)
          yield* Effect.addFinalizer(() => kill)
          const done = yield* Deferred.make<string>()
          const finish = (reason: string) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (stopped) return
                stopped = true
                const errFile = errBytes > 0 ? yield* trunc.write(errChunks.join("")).pipe(Effect.orDie) : undefined
                yield* restore(kill)
                const completed_at = Date.now()
                yield* inject(
                  renderEnd({
                    id: input.jobID,
                    description: input.description,
                    started_at: input.started_at,
                    completed_at,
                    reason,
                    eventCount: events,
                    ...(errFile ? { outputPath: errFile } : {}),
                  }),
                  input.ctx,
                )
                yield* Deferred.succeed(done, reason).pipe(Effect.ignore)
              }),
            )
          yield* Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
            Effect.sync(() => {
              errChunks.push(chunk)
              errBytes += Buffer.byteLength(chunk, "utf-8")
              while (errBytes > MAX_STDERR_BYTES && errChunks.length > 1) {
                const item = errChunks.shift()
                if (!item) break
                errBytes -= Buffer.byteLength(item, "utf-8")
              }
            }),
          ).pipe(Effect.forkScoped)
          yield* Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
            Effect.sync(() => {
              buffer += chunk
              const parts = buffer.split("\n")
              buffer = parts.pop() ?? ""
              for (const line of parts) queue.push(line.endsWith("\r") ? line.slice(0, -1) : line)
            }),
          ).pipe(Effect.forkScoped)
          yield* Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(`${BATCH_MS} millis`)
              if (stopped || queue.length === 0) return
              const batch = queue.splice(0, queue.length)
              events += batch.length
              if (events > MAX_EVENTS) {
                yield* finish(`flood guard: more than ${MAX_EVENTS} events, tighten the filter and restart`).pipe(
                  Effect.forkIn(scope, { startImmediately: true }),
                )
                return
              }
              const rendered = renderEvent(input.jobID, input.description, input.started_at, batch.length, batch)
              yield* background.report(input.jobID, rendered).pipe(Effect.ignore)
              yield* inject(rendered, input.ctx)
            }),
          ).pipe(Effect.forkScoped)
          yield* handle.exitCode
            .pipe(Effect.andThen((code) => finish(`command exited with code ${code}`)), Effect.ignore)
            .pipe(Effect.forkScoped)
          if (!input.persistent) {
            yield* Effect.sleep(`${input.timeoutMs} millis`)
              .pipe(Effect.andThen(() => finish(`timeout of ${duration(input.timeoutMs)} elapsed`)), Effect.ignore)
              .pipe(Effect.forkScoped)
          }
          return yield* Deferred.await(done)
        }),
      )
    })

    const watchSocket = Effect.fn("MonitorTool.watchSocket")(function* (input: {
      url: string
      protocols: string[]
      jobID: string
      description: string
      started_at: number
      timeoutMs: number
      persistent: boolean
      ctx: Tool.Context
    }) {
      const queue: string[] = []
      let events = 0
      let closed: string | undefined
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<string>()
          let stopped = false
          const finish = (reason: string) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (stopped) return
                stopped = true
                yield* restore(Effect.void)
                const completed_at = Date.now()
                yield* inject(
                  renderEnd({
                    id: input.jobID,
                    description: input.description,
                    started_at: input.started_at,
                    completed_at,
                    reason,
                    eventCount: events,
                  }),
                  input.ctx,
                )
                yield* Deferred.succeed(done, reason).pipe(Effect.ignore)
              }),
            )
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const ws = new WebSocket(input.url, input.protocols)
              ws.onmessage = (event) => {
                queue.push(typeof event.data === "string" ? event.data : String(event.data))
              }
              ws.onclose = (event) => {
                closed ??= `websocket closed (code ${event.code})`
              }
              ws.onerror = () => {
                closed ??= "websocket error"
              }
              return ws
            }),
            (ws) =>
              Effect.sync(() => {
                try {
                  ws.close()
                } catch {
                  return
                }
              }),
          )
          yield* Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(`${BATCH_MS} millis`)
              if (stopped) return
              if (closed !== undefined) {
                yield* finish(closed)
                return
              }
              if (queue.length === 0) return
              const batch = queue.splice(0, queue.length)
              events += batch.length
              if (events > MAX_EVENTS) {
                yield* finish(`flood guard: more than ${MAX_EVENTS} events`).pipe(
                  Effect.forkIn(scope, { startImmediately: true }),
                )
                return
              }
              const rendered = renderEvent(input.jobID, input.description, input.started_at, batch.length, batch)
              yield* background.report(input.jobID, rendered).pipe(Effect.ignore)
              yield* inject(rendered, input.ctx)
            }),
          ).pipe(Effect.forkScoped)
          if (!input.persistent) {
            yield* Effect.sleep(`${input.timeoutMs} millis`)
              .pipe(Effect.andThen(() => finish(`timeout of ${duration(input.timeoutMs)} elapsed`)), Effect.ignore)
              .pipe(Effect.forkScoped)
          }
          return yield* Deferred.await(done)
        }),
      )
    })

    // Poll an MCP tool and wake on output change: the first poll is a silent
    // baseline, every later change becomes one event. Poll failures degrade to
    // a stable error marker so a flaky server does not kill the monitor.
    const watchMcp = Effect.fn("MonitorTool.watchMcp")(function* (input: {
      jobID: string
      description: string
      started_at: number
      timeoutMs: number
      persistent: boolean
      server: string
      tool: string
      arguments?: Record<string, unknown>
      pollMs: number
      ctx: Tool.Context
    }) {
      let events = 0
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<string>()
          let stopped = false
          const finish = (reason: string) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (stopped) return
                stopped = true
                yield* restore(Effect.void)
                const completed_at = Date.now()
                yield* inject(
                  renderEnd({
                    id: input.jobID,
                    description: input.description,
                    started_at: input.started_at,
                    completed_at,
                    reason,
                    eventCount: events,
                  }),
                  input.ctx,
                )
                yield* Deferred.succeed(done, reason).pipe(Effect.ignore)
              }),
            )
          let last: string | undefined
          yield* Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(`${input.pollMs} millis`)
              if (stopped) return
              const polled = yield* callMcpTool({
                server: input.server,
                tool: input.tool,
                arguments: input.arguments,
              }).pipe(
                Effect.catchCause((cause) => {
                  const failure = Cause.squash(cause)
                  const message = failure instanceof Error ? failure.message : String(failure)
                  return Effect.succeed(`[mcp poll failed: ${message.slice(0, 200)}]`)
                }),
              )
              if (last === undefined) {
                last = polled
                return
              }
              if (polled === last) return
              last = polled
              events++
              if (events > MAX_EVENTS) {
                yield* finish(`flood guard: more than ${MAX_EVENTS} events`).pipe(
                  Effect.forkIn(scope, { startImmediately: true }),
                )
                return
              }
              const clipped =
                polled.length > MAX_MCP_EVENT_CHARS ? `${polled.slice(0, MAX_MCP_EVENT_CHARS)}\n... (truncated)` : polled
              const rendered = renderEvent(input.jobID, input.description, input.started_at, 1, clipped.split("\n"))
              yield* background.report(input.jobID, rendered).pipe(Effect.ignore)
              yield* inject(rendered, input.ctx)
            }),
          ).pipe(Effect.forkScoped)
          if (!input.persistent) {
            yield* Effect.sleep(`${input.timeoutMs} millis`)
              .pipe(Effect.andThen(() => finish(`timeout of ${duration(input.timeoutMs)} elapsed`)), Effect.ignore)
              .pipe(Effect.forkScoped)
          }
          return yield* Deferred.await(done)
        }),
      )
    })

    return {
      description: [
        "Watch something in the background and react when it changes, without pausing the conversation.",
        "Give exactly one of command, ws, or mcp. For command, each stdout line becomes one notification (lines arriving within 200ms batch together); stderr is saved to a file and never notifies.",
        "Use for tailing logs, polling PR or CI status with a script, watching files, or tracking a long-running script.",
        "For a server that already pushes events, use ws with a ws:// or wss:// URL instead of a polling script; each message becomes one notification.",
        "For a connected MCP server, use mcp with server + tool: the tool is polled and each output change (for example new unread messages) wakes you with the new output.",
        "The monitor ends after timeout_ms (default 300000, maximum 3600000) unless persistent is true, which runs until the session ends. Stop early with the background tool (action stop). You keep working while it runs; each event wakes you with a notification.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sources = [params.command !== undefined, params.ws !== undefined, params.mcp !== undefined].filter(
            (present) => present,
          )
          if (sources.length !== 1) {
            throw new Error("Provide exactly one of command, ws, or mcp.")
          }
          const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS
          if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeout_ms must not exceed ${MAX_TIMEOUT_MS}.`)
          const persistent = params.persistent === true
          let wsUrl = ""
          let protocols: string[] = []
          let mcpServer = ""
          let mcpTool = ""
          let mcpKey = ""
          let pollMs = DEFAULT_MCP_POLL_MS
          if (params.ws) {
            const invalid = validateUrl(params.ws.url)
            if (invalid) throw new Error(`Invalid ws.url: ${invalid}`)
            if (params.ws.protocols && new Set(params.ws.protocols).size !== params.ws.protocols.length) {
              throw new Error("Invalid ws.protocols: entries must be unique.")
            }
            wsUrl = params.ws.url
            protocols = [...(params.ws.protocols ?? [])]
            yield* ctx.ask({
              permission: "monitor",
              patterns: [wsUrl],
              always: [],
              metadata: { description: params.description, url: wsUrl },
            })
          } else if (params.mcp) {
            mcpServer = params.mcp.server
            mcpTool = params.mcp.tool
            mcpKey = McpCatalog.toolName(mcpServer, mcpTool)
            pollMs = params.mcp.poll_ms ?? DEFAULT_MCP_POLL_MS
            if (pollMs < MIN_MCP_POLL_MS) throw new Error(`mcp.poll_ms must be at least ${MIN_MCP_POLL_MS}.`)
            if (pollMs > MAX_MCP_POLL_MS) throw new Error(`mcp.poll_ms must not exceed ${MAX_MCP_POLL_MS}.`)
            const tools = yield* mcp.tools()
            if (!tools[mcpKey]) {
              const available = Object.keys(tools).toSorted((a, b) => a.localeCompare(b)).join(", ") || "(none)"
              throw new Error(`Unknown MCP tool: "${mcpKey}". Available MCP tools: ${available}.`)
            }
            yield* ctx.ask({
              permission: mcpKey,
              patterns: ["*"],
              always: ["*"],
              metadata: { description: params.description, server: mcpServer, tool: mcpTool },
            })
          } else {
            yield* ctx.ask({
              permission: ShellID.ToolID,
              patterns: [params.command!],
              always: [params.command!],
              metadata: { command: params.command, description: params.description },
            })
          }
          const cfg = yield* config.get()
          const shell = Shell.acceptable(cfg.shell)
          const instanceCtx = yield* InstanceState.context
          const extra = yield* plugin.trigger(
            "shell.env",
            { cwd: instanceCtx.directory, sessionID: ctx.sessionID, callID: ctx.callID },
            { env: {} },
          )
          const started_at = Date.now()
          const id = Identifier.ascending("job")
          const runEffect = params.command
            ? watchCommand({
                shell,
                command: params.command,
                cwd: instanceCtx.directory,
                env: { ...process.env, ...extra.env },
                jobID: id,
                description: params.description,
                started_at,
                timeoutMs,
                persistent,
                ctx,
              })
            : params.mcp
              ? watchMcp({
                  jobID: id,
                  description: params.description,
                  started_at,
                  timeoutMs,
                  persistent,
                  server: mcpServer,
                  tool: mcpTool,
                  arguments: params.mcp.arguments ? { ...params.mcp.arguments } : undefined,
                  pollMs,
                  ctx,
                })
              : watchSocket({
                  url: wsUrl,
                  protocols,
                  jobID: id,
                  description: params.description,
                  started_at,
                  timeoutMs,
                  persistent,
                  ctx,
                })
          const info = yield* background.start({
            id,
            type: "monitor",
            title: params.description,
            metadata: {
              description: params.description,
              background: true,
              ...(params.command !== undefined
                ? { command: params.command }
                : params.mcp
                  ? { mcp: `${mcpServer}/${mcpTool}` }
                  : { url: wsUrl }),
            },
            run: runEffect,
          })
          const source = params.command
            ? `command: ${params.command}`
            : params.mcp
              ? `mcp: ${mcpServer}/${mcpTool} (polls every ${duration(pollMs)})`
              : `websocket: ${wsUrl}`
          const output = [
            `<background_job id="${info.id}" state="running" started_at="${started_at}">`,
            `Monitor "${params.description}" started (${source}). Started at ${clock(started_at)}.`,
            persistent
              ? `It runs until the session ends. Stop it with the background tool (action "stop", job_id "${info.id}").`
              : `It stops after ${duration(timeoutMs)}. Stop it earlier with the background tool (action "stop", job_id "${info.id}").`,
            `Each event wakes you with a notification. Do not poll.`,
            `</background_job>`,
          ].join("\n")
    return {
            title: params.description,
            metadata: {
              output,
              userOutput: persistent
                ? `Listening since ${clock(started_at)} · runs until stopped`
                : `Listening since ${clock(started_at)} · stops after ${duration(timeoutMs)}`,
              background: true,
              jobId: info.id,
              started_at,
              activity: {
                kind: "monitor" as const,
                id: info.id,
                description: params.description,
                started_at,
                ...(persistent ? {} : { deadline: started_at + timeoutMs }),
              },
            },
            output,
          }
        }),
    }
  }),
)

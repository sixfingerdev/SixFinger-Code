import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { McpCatalog } from "../../src/mcp/catalog"
import { MCP, type McpTool } from "../../src/mcp"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { MonitorTool } from "../../src/tool/monitor"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "../../src/plugin"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import path from "path"

afterEach(async () => {
  await disposeAllInstances()
})

// The fake MCP tool returns one output per call; the monitor's first poll is
// the baseline, so the change wakes on the second.
const outputs = ["unread: none", "unread: none", "unread: alice\nhello from alice"]
let call = 0

const mcpLayer = Layer.mock(MCP.Service, {
  tools: () =>
    Effect.succeed({
      [McpCatalog.toolName("slack", "get_unread")]: {
        def: { name: "get_unread", inputSchema: { type: "object", properties: {} } } as unknown as McpTool["def"],
        client: {
          callTool: () => {
            const text = outputs[Math.min(call++, outputs.length - 1)]
            return Promise.resolve({ isError: false, content: [{ type: "text" as const, text }] })
          },
        } as unknown as McpTool["client"],
      } as unknown as McpTool,
    }),
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        CrossSpawnSpawner.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        BackgroundJob.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ).pipe(Layer.provideMerge(mcpLayer)),
)

const projectRoot = path.join(__dirname, "../..")

describe("tool.monitor", () => {
  it.live(
    "wakes the session when a polled MCP tool changes output",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          const events: string[] = []
      const promptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input: { parts: ReadonlyArray<{ type: string; text?: string }> }) =>
          Effect.sync(() => {
            for (const part of input.parts) {
              if (part.text?.includes("<monitor_event")) events.push(part.text)
            }
            return {
              info: {
                id: MessageID.ascending(),
                role: "assistant" as const,
                parentID: MessageID.ascending(),
                sessionID: SessionID.make("ses_test"),
                mode: "build",
                agent: "build",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "test-model",
                providerID: "test",
                time: { created: Date.now() },
                finish: "stop" as const,
              },
              parts: [],
            } as never
          }),
      }

      const tool = yield* MonitorTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "unread messages",
          mcp: { server: "slack", tool: "get_unread", poll_ms: 1000 },
          timeout_ms: 30000,
        },
        {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      const jobID = String(result.metadata.jobId)

      const event = yield* pollWithTimeout(
        Effect.sync(() => events.find((text) => text.includes("hello from alice"))),
        "monitor never woke on MCP output change",
        "15 seconds",
      )
      expect(event).toContain("<monitor_event")
      expect(event).toContain("unread: alice")

      const background = yield* BackgroundJob.Service
      yield* background.cancel(jobID)
        },
      ),
    ),
    30_000,
  )

  it.live(
    "rejects an unknown MCP tool with available tools",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          const tool = yield* MonitorTool
          const def = yield* tool.init()
          const exit = yield* def
            .execute(
              {
                description: "unread messages",
                mcp: { server: "slack", tool: "missing" },
              },
              {
                sessionID: SessionID.make("ses_test"),
                messageID: MessageID.ascending(),
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }),
      ),
    15_000,
  )
})

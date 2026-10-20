import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import * as ToolSearch from "../../src/tool/tool-search"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const fakeAgent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const it = testEffect(
  Layer.mergeAll(
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["lsp", "plan", "shell"]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        search: (input: { query: string }) =>
          Effect.succeed(
            input.query.toLowerCase().includes("diag")
              ? { matched: ["lsp"], enabled: ["lsp"] }
              : { matched: [], enabled: [] },
          ),
        tools: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(Agent.Service, Agent.Service.of({ get: (name: string) => Effect.succeed(fakeAgent) } as never)),
  ),
)

describe("tool.tool_search", () => {
  const ctx = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }

  it.live("activates matching deferred tools", () =>
    Effect.gen(function* () {
      const tool = yield* ToolSearch.create(() => Effect.succeed({ matched: ["lsp"], enabled: ["lsp"] }))
      const def = yield* tool.init()
      const result = yield* def.execute({ query: "diagnostics" }, ctx)
      expect(result.output).toContain('enabled="1"')
      expect(result.output).toContain("<tool>lsp</tool>")
      expect(result.output).toContain("Activated 1 tool(s)")
    }),
  )

  it.live("reports no matches", () =>
    Effect.gen(function* () {
      const tool = yield* ToolSearch.create(() => Effect.succeed({ matched: [], enabled: [] }))
      const def = yield* tool.init()
      const result = yield* def.execute({ query: "nope" }, ctx)
      expect(result.output).toContain('No hidden tools match "nope"')
    }),
  )
})

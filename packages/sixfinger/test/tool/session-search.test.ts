import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@sixfinger/core/effect/layer-node"
import { ProviderV2 } from "@sixfinger/core/provider"
import { ModelV2 } from "@sixfinger/core/model"
import { Database } from "@sixfinger/core/database/database"
import { SessionProjector } from "@sixfinger/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@sixfinger/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSearchTool } from "../../src/tool/session-search"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Config.node,
      Session.node,
      SessionProjector.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)

const it = testEffect(layer)

const projectRoot = path.join(__dirname, "../..")

afterEach(async () => {
  await disposeAllInstances()
})

const seed = Effect.fn("SessionSearchTest.seed")(function* (count = 1) {
  const chats: SessionID[] = []
  for (let index = 0; index < count; index++) {
    const chat = yield* Session.use.create({ title: `search test ${index}` })
    chats.push(chat.id)
  }
  return chats
})

const addUserText = Effect.fn("SessionSearchTest.addUserText")(function* (sessionID: SessionID, text: string) {
  const user = yield* Session.use.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* Session.use.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text,
    time: { start: Date.now() },
  })
  return { userID: user.id }
})

const ctxOf = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.session_search", () => {
  it.instance(
    "finds plain text in the current session",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed()
          yield* addUserText(chats[0]!, "The cache key should use SHA256 with the file path, remember that.")

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()
          const result = yield* def.execute({ query: "SHA256" }, ctxOf(chats[0]!, MessageID.ascending()))

          expect(result.output).toContain("SHA256")
          expect(result.output).toContain("<session_search")
          expect(result.output).toContain('matches="1"')
        }),
      ),
    { git: true },
  )

  it.instance(
    "supports regex mode and reports invalid regex",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed()
          yield* addUserText(chats[0]!, "configured apiKey = 'sk-live-999' in production")

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()
          const hit = yield* def.execute(
            { query: String.raw`apiKey\s*=\s*['"][^'"]+`, is_regex: true },
            ctxOf(chats[0]!, MessageID.ascending()),
          )
          expect(hit.output).toContain("sk-live-999")

          const bad = yield* def
            .execute({ query: "([unclosed", is_regex: true }, ctxOf(chats[0]!, MessageID.ascending()))
            .pipe(Effect.exit)
          expect(bad._tag).toBe("Failure")
        }),
      ),
    { git: true },
  )

  it.instance(
    "scope all finds matches across sessions",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed(2)
          yield* addUserText(chats[0]!, "we decided to use postgres for the cache store")

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()

          const scoped = yield* def.execute({ query: "postgres" }, ctxOf(chats[1]!, MessageID.ascending()))
          expect(scoped.output).toContain("No matches")

          const all = yield* def.execute({ query: "postgres", scope: "all" }, ctxOf(chats[1]!, MessageID.ascending()))
          expect(all.output).toContain("postgres")
          expect(all.output).toContain(`session="${chats[0]}"`)
        }),
      ),
    { git: true },
  )

  it.instance(
    "searches original tool output of compacted parts",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed()
          const user = yield* Session.use.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chats[0]!,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* Session.use.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: chats[0]!,
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "ran migration 0042: added users.api_token column",
              title: "migration",
              metadata: {},
              time: { start: Date.now(), end: Date.now(), compacted: Date.now() },
            },
          })

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()
          const result = yield* def.execute({ query: "api_token" }, ctxOf(chats[0]!, user.id))
          expect(result.output).toContain("added users.api_token column")
          expect(result.output).toContain('compacted="true"')
        }),
      ),
    { git: true },
  )

  it.instance(
    "respects role filter and limit",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed()
          const user = yield* Session.use.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chats[0]!,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const assistant = yield* Session.use.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user.id,
            sessionID: chats[0]!,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
          })
          yield* Session.use.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: chats[0]!,
            type: "text",
            text: "mention of redis here",
            time: { start: Date.now() },
          })
          yield* Session.use.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: chats[0]!,
            type: "text",
            text: "mention of redis here too",
            time: { start: Date.now() },
          })

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()
          const ctx = ctxOf(chats[0]!, user.id)

          const onlyUser = yield* def.execute({ query: "redis", role: "user" }, ctx)
          expect(onlyUser.output).toContain('matches="1"')

          const limited = yield* def.execute({ query: "redis", limit: 1 }, ctx)
          expect(limited.output).toContain('matches="1"')
        }),
      ),
    { git: true },
  )

  it.instance(
    "message_id reads the full message and context widens snippets",
    () =>
      provideInstance(projectRoot)(
        Effect.gen(function* () {
          yield* TestInstance
          const chats = yield* seed()
          const user = yield* Session.use.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chats[0]!,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* Session.use.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: chats[0]!,
            type: "text",
            text:
              "Earlier planning notes about the storage layer: " +
              "we reviewed object stores, lifecycle rules, partitioning, and retention windows at length. ".repeat(4) +
              "The ICEBERG decision: keep the cold storage tier on S3, metadata stays in postgres, revisit after the migration lands. " +
              "Follow-ups: backfill job, schema registry, and compaction cadence were left open. ".repeat(4) +
              "That is the full context of the decision.",
            time: { start: Date.now() },
          })

          const tool = yield* SessionSearchTool
          const def = yield* tool.init()
          const ctx = ctxOf(chats[0]!, user.id)

          const found = yield* def.execute({ query: "ICEBERG" }, ctx)
          expect(found.output).toContain("ICEBERG")
          expect(found.output).toContain('message_id="') 
          const messageID = found.output.match(/message_id="([^"]+)"/)?.[1] ?? ""

          const wide = yield* def.execute({ query: "ICEBERG", context: 500 }, ctx)
          expect(wide.output.length).toBeGreaterThan(found.output.length)

          const zoomed = yield* def.execute({ message_id: messageID }, ctx)
          expect(zoomed.output).toContain(`<message id="${messageID}"`)
          expect(zoomed.output).toContain("cold storage tier on S3")
          expect(zoomed.output).toContain("metadata stays in postgres")
        }),
      ),
    { git: true },
  )
})

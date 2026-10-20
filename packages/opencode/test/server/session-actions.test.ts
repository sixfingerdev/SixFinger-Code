import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Identifier } from "@opencode-ai/core/id/id"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(SessionNs.node), LayerNode.compile(BackgroundJob.node), httpApiLayer),
)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "experimental background job route reports live output and misses unknown jobs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const background = yield* BackgroundJob.Service
        const job = yield* background.start({
          id: Identifier.ascending("job"),
          type: "bash",
          title: "sleepy",
          metadata: { background: true, outputPath: "/tmp/err.log" },
          run: Effect.succeed("job finished output"),
        })

        const res = yield* requestInDirectory(`/experimental/background/${job.id}`, test.directory)
        expect(res.status).toBe(200)
        const body = (yield* res.json) as {
          id: string
          type: string
          status: string
          title?: string
          output: string
          truncated: boolean
          outputPath?: string
        }
        expect(body.id).toBe(job.id)
        expect(body.type).toBe("bash")
        expect(body.title).toBe("sleepy")
        expect(body.output).toBe("job finished output")
        expect(body.truncated).toBe(false)
        expect(body.outputPath).toBe("/tmp/err.log")

        const missing = yield* requestInDirectory("/experimental/background/job_missing", test.directory)
        expect(missing.status).toBe(404)
      }),
    { git: true },
  )

  it.instance(
    "experimental background job route serves reported progress while running",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const background = yield* BackgroundJob.Service
        const job = yield* background.start({
          id: Identifier.ascending("job"),
          type: "bash",
          metadata: { background: true },
          run: Effect.never,
        })
        yield* background.report(job.id, "TEST 1\n")
        yield* background.report(job.id, "TEST 2\n")

        const res = yield* requestInDirectory(`/experimental/background/${job.id}`, test.directory)
        expect(res.status).toBe(200)
        const body = (yield* res.json) as { status: string; output: string }
        expect(body.status).toBe("running")
        expect(body.output).toBe("TEST 1\nTEST 2\n")

        yield* background.cancel(job.id)
        const done = yield* requestInDirectory(`/experimental/background/${job.id}`, test.directory)
        expect(done.status).toBe(200)
        const doneBody = (yield* done.json) as { status: string; output: string }
        expect(doneBody.status).toBe("cancelled")
        // Output captured up to cancellation stays visible in the details.
        expect(doneBody.output).toBe("TEST 1\nTEST 2\n")
      }),
    { git: true },
  )

  it.instance(
    "experimental cron routes list entries and miss unknown ids",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const res = yield* requestInDirectory("/experimental/cron", test.directory)
        expect(res.status).toBe(200)
        const body = (yield* res.json) as unknown[]
        expect(Array.isArray(body)).toBe(true)

        const missing = yield* requestInDirectory("/experimental/cron/cron_missing", test.directory, {
          method: "DELETE",
        })
        expect(missing.status).toBe(404)
      }),
    { git: true },
  )
})

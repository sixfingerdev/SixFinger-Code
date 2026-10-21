import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { compact, createBridge, httpLocal } from "../../src/sixfinger/link"

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })

describe("uzaktan köprü", () => {
  const localPosts: Array<{ path: string; query: string; body: any }> = []
  const syncs: any[] = []
  const polls: any[] = []
  let registered: any
  let pollQueue: any[] = []
  let queue: any[] = []
  let local: ReturnType<typeof Bun.serve>
  let remote: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    local = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        if (req.method === "POST") {
          localPosts.push({ path: u.pathname, query: u.search, body: await req.json().catch(() => undefined) })
          if (u.pathname === "/session") return json({ id: "ses_new" })
          return new Response(null, { status: 204 })
        }
        if (u.pathname === "/experimental/session") return json([{ id: "ses_1", title: "Hata ayıkla", directory: "/proj", time: { updated: 5 } }])
        if (u.pathname === "/session/status") return json({ ses_1: { type: "busy" } })
        if (u.pathname === "/permission") return json([{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] }])
        if (u.pathname === "/question") return json([])
        if (u.pathname === "/session/ses_1/message")
          return json([
            { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "testleri çalıştır" }, { type: "text", text: "gizli", synthetic: true }] },
            { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", title: "ls", input: { command: "ls" }, output: "x".repeat(5000) } }] },
          ])
        return json({}, 404)
      },
    })
    remote = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        if (req.headers.get("authorization") !== "Bearer tok") return json({}, 401)
        if (u.pathname === "/api/link/register") {
          registered = await req.json()
          return json({ deviceId: "dev-1" })
        }
        if (u.pathname === "/api/link/poll") {
          polls.push(await req.json())
          const commands = pollQueue
          pollQueue = []
          return json({ commands })
        }
        if (u.pathname === "/api/link/sync") {
          syncs.push(await req.json())
          const commands = queue
          queue = []
          return json({ commands })
        }
        return json({}, 404)
      },
    })
  })
  afterAll(() => {
    local.stop(true)
    remote.stop(true)
  })

  test("oturumları özetler, bekleyen izni bildirir, gizli/sentetik metni atar, çıktıyı kırpar", async () => {
    const bridge = createBridge(httpLocal(`http://localhost:${local.port}`), { server: `http://localhost:${remote.port}`, token: async () => "tok" })
    const r = await bridge.tick()
    expect(r.busy).toBe(true)
    const s = syncs[0].sessions[0]
    expect(syncs[0].deviceId).toBe("dev-1")
    expect(s).toMatchObject({ id: "ses_1", title: "Hata ayıkla", directory: "/proj", status: "waiting" })
    expect(s.pending).toEqual([{ kind: "permission", requestId: "per_1", permission: "bash", patterns: ["ls"] }])
    expect(s.snapshot[0].parts).toEqual([{ type: "text", text: "testleri çalıştır" }])
    expect(s.snapshot[1].parts[0].output.length).toBeLessThan(1_600)
  })

  test("sunucudan gelen komutları yerel sunucuya iletir", async () => {
    queue = [
      { id: "c1", sessionId: "ses_1", kind: "prompt", payload: { text: "devam et" } },
      { id: "c2", sessionId: "ses_1", kind: "permission", payload: { requestId: "per_1", reply: "once" } },
      { id: "c3", sessionId: "ses_1", kind: "abort", payload: {} },
      { id: "c4", sessionId: "ses_1", kind: "question", payload: { requestId: "que_1", answers: [["Evet"]] } },
    ]
    localPosts.length = 0
    const bridge = createBridge(httpLocal(`http://localhost:${local.port}`), { server: `http://localhost:${remote.port}`, token: async () => "tok" })
    await bridge.tick() // komutlar bu turda gelir ve uygulanır
    expect(localPosts.map((p) => p.path)).toEqual(["/session/ses_1/prompt_async", "/permission/per_1/reply", "/session/ses_1/abort", "/question/que_1/reply"])
    expect(localPosts[0]!.body).toEqual({ parts: [{ type: "text", text: "devam et" }] })
    expect(localPosts[0]!.query).toContain("directory=%2Fproj")
    expect(localPosts[1]!.body).toEqual({ reply: "once" })
    expect(localPosts[3]!.body).toEqual({ answers: [["Evet"]] })
  })

  test("değişmeyen oturumun anlık görüntüsü tekrar gönderilmez", async () => {
    const bridge = createBridge(httpLocal(`http://localhost:${local.port}`), { server: `http://localhost:${remote.port}`, token: async () => "tok" })
    syncs.length = 0
    await bridge.tick()
    await bridge.tick()
    expect(syncs[0].sessions[0].snapshot).toBeDefined()
    expect(syncs[1].sessions[0].snapshot).toBeUndefined()
  })

  test("compact: mesaj sayısı ve metin sınırlanır", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ info: { id: `m${i}`, role: "user", time: { created: i } }, parts: [{ type: "text", text: "a".repeat(20_000) }] }))
    const out = compact(many)
    expect(out).toHaveLength(40)
    expect(out[0]!.parts[0].text.length).toBeLessThan(8_100)
  })

  const mk = () => createBridge(httpLocal(`http://localhost:${local.port}`), { server: `http://localhost:${remote.port}`, token: async () => "tok" })

  test("kayıtta protokol ve yetenekleri bildirir", async () => {
    await mk().tick()
    expect(registered.protocol).toBe(1)
    expect(registered.capabilities).toEqual(["prompt", "abort", "permission", "question", "new_session"])
  })

  test("uygulanan komutların onayı (ack) bir sonraki istekte gider; hata metni taşınır", async () => {
    const b = mk()
    await b.tick()
    queue = [
      { id: "a1", sessionId: "ses_1", kind: "abort", payload: {} },
      { id: "a2", sessionId: "ses_1", kind: "tool.custom", payload: {} }, // sunucunun/CLI'nın tanımadığı tür
      { id: "a3", sessionId: "yok", kind: "prompt", payload: { text: "x" } }, // yerelde olmayan oturum
    ]
    await b.tick()
    const acks = b.flushAcks()
    expect(acks).toEqual([
      { id: "a1", ok: true },
      { id: "a2", ok: false, error: "desteklenmeyen komut: tool.custom" },
      { id: "a3", ok: false, error: "oturum yerelde yok" },
    ])
    syncs.length = 0
    await b.tick()
    expect(syncs[0].acks).toHaveLength(3)
    expect(b.flushAcks()).toEqual([])
  })

  test("aynı komut yeniden teslim edilirse tekrar çalıştırılmaz, yeniden onaylanır", async () => {
    const b = mk()
    await b.tick()
    localPosts.length = 0
    const cmd = { id: "dup1", sessionId: "ses_1", kind: "prompt", payload: { text: "bir kez", model: "deep" } }
    await b.handle([cmd])
    await b.handle([cmd])
    expect(localPosts.filter((p) => p.path.endsWith("prompt_async"))).toHaveLength(1)
    expect(localPosts[0]!.body.model).toEqual({ providerID: "sixfinger", modelID: "deep" })
    expect(b.flushAcks()).toEqual([
      { id: "dup1", ok: true },
      { id: "dup1", ok: true },
    ])
  })

  test("new_session: yerelde oturum açar ve ilk mesajı gönderir", async () => {
    const b = mk()
    await b.tick()
    localPosts.length = 0
    await b.handle([{ id: "n1", sessionId: "", kind: "new_session", payload: { directory: "/yeni", text: "başla", model: "fast" } }])
    expect(localPosts.map((p) => p.path)).toEqual(["/session", "/session/ses_new/prompt_async"])
    expect(localPosts[0]!.query).toContain("directory=%2Fyeni")
    expect(b.flushAcks()).toEqual([{ id: "n1", ok: true }])
  })

  test("uzun yoklama döngüsü komutu uygular ve onayı sonraki yoklamayla gönderir", async () => {
    const b = mk()
    await b.tick() // kayıt
    localPosts.length = 0
    polls.length = 0
    pollQueue = [{ id: "p1", sessionId: "ses_1", kind: "abort", payload: {} }]
    const ac = new AbortController()
    const run = b.loop(ac.signal)
    await new Promise((r) => setTimeout(r, 1500))
    ac.abort()
    await run.catch(() => {})
    expect(localPosts.some((p) => p.path === "/session/ses_1/abort")).toBe(true)
    expect(polls.some((p) => p.acks?.some((a: any) => a.id === "p1" && a.ok))).toBe(true)
    expect(polls[0].wait).toBe(15)
  })
})

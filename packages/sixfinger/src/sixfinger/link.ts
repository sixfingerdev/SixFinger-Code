import { createHash } from "crypto"
import os from "os"
import * as Login from "./login"

/**
 * Uzaktan köprü: bu cihazdaki SixFinger Code oturumlarını SixFinger sunucusuna özetler (site/uygulamadan izlenir) ve
 * oradan gelen komutları (mesaj gönder, durdur, izin/soru yanıtı) yerel sunucuya iletir. Yalnızca DIŞARI bağlanır; cihazda port açılmaz.
 * Oturumların kendisi cihazda kalır: sunucuya kırpılmış bir özet gider.
 */

export interface LocalApi {
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>
  post<T = unknown>(path: string, query: Record<string, string | undefined>, body?: unknown): Promise<T | undefined>
  /** Yerel sunucunun olay akışı (SSE). Kapanırsa/kopunca promise biter; çağıran yeniden dener. */
  events?(onEvent: () => void, signal: AbortSignal): Promise<void>
}

export interface Remote {
  server: string
  /** `force`: önbellekteki jetonu atla ve yenile (401 sonrası). */
  token: (force?: boolean) => Promise<string>
}

/** Bu CLI'nın anladığı komut türleri; sunucuya bildirilir. Bilinmeyen tür gelirse "desteklenmeyen komut" diye onaylanır. */
export const CAPABILITIES = ["prompt", "abort", "permission", "question", "new_session"]
export const PROTOCOL = 1

interface Cmd {
  id: string
  sessionId: string
  kind: string
  payload: Json
}
interface Ack {
  id: string
  ok: boolean
  error?: string
}

type Json = Record<string, any>

const MESSAGES = 40
const TEXT_MAX = 8_000
const OUT_MAX = 1_500

const clip = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "")
  return t.length > n ? t.slice(0, n) + "…" : t
}

/** Yerel mesajları sunucuya gidecek sade biçime çevirir (araç çıktıları ve metinler kırpılır, gizli alanlar atılır). */
export function compact(list: Array<{ info: Json; parts: Json[] }>): Json[] {
  return list.slice(-MESSAGES).map(({ info, parts }) => ({
    id: info.id,
    role: info.role,
    time: info.time?.created ?? 0,
    parts: parts.flatMap((p): Json[] => {
      switch (p.type) {
        case "text":
          return p.synthetic || p.ignored ? [] : [{ type: "text", text: clip(p.text, TEXT_MAX) }]
        case "reasoning":
          return [{ type: "reasoning", text: clip(p.text, 2_000) }]
        case "tool":
          return [
            {
              type: "tool",
              tool: p.tool,
              status: p.state?.status,
              title: p.state?.title ?? "",
              input: clip(p.state?.input, 500),
              output: p.state?.status === "completed" ? clip(p.state.output, OUT_MAX) : p.state?.status === "error" ? clip(p.state.error, OUT_MAX) : "",
            },
          ]
        case "patch":
          return [{ type: "patch", files: (p.files ?? []).slice(0, 50) }]
        case "file":
          return [{ type: "file", filename: p.filename ?? "", mime: p.mime ?? "" }]
        default:
          return []
      }
    }),
  }))
}

export interface SessionInfo {
  id: string
  title: string
  directory: string
  updated: number
}

const statusOf = (t: string | undefined): "idle" | "busy" | "waiting" => (t === "busy" || t === "retry" ? "busy" : "idle")

export function createBridge(local: LocalApi, remote: Remote, opts: { name?: string; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {})
  const name = opts.name ?? os.hostname()
  let deviceId: string | undefined
  const dirOf = new Map<string, string>()
  const seen = new Map<string, string>() // oturum → son parmak izi
  let sent = new Set<string>()
  let acks: Ack[] = []
  /** Uygulanmış komutlar (kimlik → sonuç): sunucu aynı komutu yeniden teslim ederse tekrar çalıştırmadan yeniden onaylanır. */
  const finished = new Map<string, Ack>()
  let wake: (() => void) | undefined

  async function api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: T }> {
    const once = async (force: boolean) => {
      const res = await fetch(`${remote.server}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await remote.token(force)}` },
        body: JSON.stringify(body),
        signal,
      })
      return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
    }
    const r = await once(false)
    return r.status === 401 ? once(true) : r
  }

  async function register() {
    const r = await api<{ deviceId: string; error?: { message?: string } }>("/link/register", {
      name,
      platform: `${os.platform()}-${os.arch()}`,
      version: process.env.SIXFINGER_VERSION ?? "",
      protocol: PROTOCOL,
      capabilities: CAPABILITIES,
    })
    if (r.status === 426) throw new Error(r.json.error?.message ?? "CLI sürümü eski, güncelle.")
    if (r.status !== 200) throw new Error(`register ${r.status}`)
    deviceId = r.json.deviceId
  }

  /** Bir tur: yerel durumu topla → sunucuya gönder → gelen komutları uygula. Dönüş: bu turda iş var mı (hızlı döngü için). */
  async function tick(): Promise<{ busy: boolean }> {
    if (!deviceId) await register()
    const list = await local.get<Json[]>("/experimental/session", { roots: "true", limit: 25 })
    const dirs = [...new Set(list.map((s) => s.directory as string))]
    const status = new Map<string, string>()
    const pending = new Map<string, Json[]>()
    for (const dir of dirs) {
      const st = await local.get<Record<string, Json>>("/session/status", { directory: dir }).catch(() => ({}) as Record<string, Json>)
      for (const [id, v] of Object.entries(st)) status.set(id, v?.type)
      const perms = await local.get<Json[]>("/permission", { directory: dir }).catch(() => [])
      const qs = await local.get<Json[]>("/question", { directory: dir }).catch(() => [])
      for (const p of perms) pending.set(p.sessionID, [...(pending.get(p.sessionID) ?? []), { kind: "permission", requestId: p.id, permission: p.permission, patterns: (p.patterns ?? []).slice(0, 10) }])
      for (const q of qs) pending.set(q.sessionID, [...(pending.get(q.sessionID) ?? []), { kind: "question", requestId: q.id, questions: clip(q.questions, 2_000) }])
    }

    const sessions: Json[] = []
    let anyBusy = false
    for (const s of list) {
      dirOf.set(s.id, s.directory)
      const st = statusOf(status.get(s.id))
      const waiting = (pending.get(s.id) ?? []).length > 0
      if (st === "busy") anyBusy = true
      const entry: Json = { id: s.id, title: s.title ?? "", directory: s.directory, status: waiting ? "waiting" : st, updatedAt: new Date(s.time?.updated ?? Date.now()).toISOString() }
      const pend = pending.get(s.id) ?? []
      const fp = createHash("sha1").update(`${s.time?.updated}|${st}|${JSON.stringify(pend)}`).digest("hex")
      if (seen.get(s.id) !== fp || st === "busy") {
        const msgs = await local.get<Array<{ info: Json; parts: Json[] }>>(`/session/${s.id}/message`, { directory: s.directory, limit: MESSAGES })
        const snap = compact(msgs)
        const fp2 = createHash("sha1").update(JSON.stringify(snap) + JSON.stringify(pend)).digest("hex")
        if (seen.get(s.id) !== fp2) {
          entry.snapshot = snap
          entry.pending = pend
          seen.set(s.id, fp2)
        }
      }
      sessions.push(entry)
    }
    const now = new Set(list.map((s) => s.id))
    const gone = [...sent].filter((id) => !now.has(id))
    sent = now
    for (const id of gone) seen.delete(id)

    const sending = acks
    acks = []
    const r = await api<{ commands: Cmd[] }>("/link/sync", { deviceId, sessions, gone, acks: sending })
    if (r.status === 404) {
      deviceId = undefined // sunucu cihazı unuttu (silinmiş): yeniden kaydol
      acks = [...sending, ...acks]
      return { busy: true }
    }
    if (r.status !== 200) {
      acks = [...sending, ...acks] // ulaşmadı: bir sonraki istekte yeniden gönder
      throw new Error(`sync ${r.status}`)
    }
    await handle(r.json.commands)
    return { busy: anyBusy || r.json.commands.length > 0 }
  }

  /** Gelen komutları sırayla uygular; her biri için onay (ack) biriktirir. Daha önce uygulananı yeniden çalıştırmaz. */
  async function handle(cmds: Cmd[]) {
    for (const c of cmds) {
      const prev = finished.get(c.id)
      if (prev) {
        acks.push(prev)
        continue
      }
      let ack: Ack
      try {
        await run(c)
        ack = { id: c.id, ok: true }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        log(`komut başarısız (${c.kind}): ${error}`)
        ack = { id: c.id, ok: false, error: error.slice(0, 400) }
      }
      finished.set(c.id, ack)
      if (finished.size > 500) finished.delete(finished.keys().next().value!)
      acks.push(ack)
      seen.delete(c.sessionId) // sonucu hızla göster
    }
    if (cmds.length) wake?.()
  }

  const modelOf = (m: unknown) => (m === "fast" || m === "deep" ? { model: { providerID: "sixfinger", modelID: m } } : {})

  async function run(c: Cmd) {
    if (c.kind === "new_session") {
      const dir = typeof c.payload.directory === "string" && c.payload.directory ? c.payload.directory : process.cwd()
      const created = await local.post<{ id: string }>("/session", { directory: dir }, {})
      if (!created?.id) throw new Error("oturum oluşturulamadı")
      dirOf.set(created.id, dir)
      const text = String(c.payload.text ?? "").trim()
      if (text) await local.post(`/session/${created.id}/prompt_async`, { directory: dir }, { parts: [{ type: "text", text }], ...modelOf(c.payload.model) })
      return
    }
    if (!CAPABILITIES.includes(c.kind)) throw new Error(`desteklenmeyen komut: ${c.kind}`)
    const directory = dirOf.get(c.sessionId)
    if (!directory) throw new Error("oturum yerelde yok")
    switch (c.kind) {
      case "prompt":
        return void (await local.post(`/session/${c.sessionId}/prompt_async`, { directory }, { parts: [{ type: "text", text: String(c.payload.text ?? "") }], ...modelOf(c.payload.model) }))
      case "abort":
        return void (await local.post(`/session/${c.sessionId}/abort`, { directory }))
      case "permission":
        return void (await local.post(`/permission/${c.payload.requestId}/reply`, { directory }, { reply: c.payload.reply }))
      case "question":
        return void (c.payload.reject
          ? await local.post(`/question/${c.payload.requestId}/reject`, { directory })
          : await local.post(`/question/${c.payload.requestId}/reply`, { directory }, { answers: c.payload.answers ?? [] }))
    }
  }

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      function done() {
        clearTimeout(t)
        wake = undefined
        signal.removeEventListener("abort", done)
        resolve()
      }
      wake = done
      signal.addEventListener("abort", done, { once: true })
    })

  let lastState = ""
  const state = (s: string) => {
    if (s !== lastState) {
      lastState = s
      log(s)
    }
  }

  /** İtme döngüsü: yerel olay gelince hemen (debounce), yoksa en geç 5 sn'de bir; iş varken 1 sn. Hata olursa üstel bekleme. */
  async function pushLoop(signal: AbortSignal) {
    let backoff = 0
    while (!signal.aborted) {
      let wait = 5_000
      try {
        const { busy } = await tick()
        if (backoff) state("bağlandı")
        backoff = 0
        if (busy) wait = 1_000
      } catch (e) {
        if (e instanceof Login.LoginRequiredError) throw e
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000)
        wait = backoff
        state(`bağlantı sorunu: ${e instanceof Error ? e.message : String(e)} (yeniden deneniyor)`)
      }
      await sleep(wait, signal)
    }
  }

  /** Çekme döngüsü: sunucuya uzun yoklama; komut gelince anında döner. Komutları uygular, onayları bir sonraki istekle yollar. */
  async function pollLoop(signal: AbortSignal) {
    let backoff = 0
    while (!signal.aborted) {
      if (!deviceId) {
        await sleep(500, signal)
        continue
      }
      try {
        const sending = acks
        acks = []
        const r = await api<{ commands: Cmd[] }>("/link/poll", { deviceId, acks: sending, wait: 15 }, signal).catch((e) => {
          acks = [...sending, ...acks]
          throw e
        })
        if (r.status === 404) {
          deviceId = undefined
          acks = [...sending, ...acks]
          continue
        }
        if (r.status !== 200) {
          acks = [...sending, ...acks]
          throw new Error(`poll ${r.status}`)
        }
        backoff = 0
        if (r.json.commands.length) await handle(r.json.commands)
      } catch (e) {
        if (signal.aborted) return
        if (e instanceof Login.LoginRequiredError) throw e
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000)
        await sleep(backoff, signal)
      }
    }
  }

  /** Yerel sunucunun olay akışını dinler; her olayda itme döngüsünü hemen uyandırır (150 ms toplayarak). */
  async function watchLocal(signal: AbortSignal) {
    if (!local.events) return
    let timer: ReturnType<typeof setTimeout> | undefined
    while (!signal.aborted) {
      await local
        .events(() => {
          if (timer) return
          timer = setTimeout(() => {
            timer = undefined
            wake?.()
          }, 150)
        }, signal)
        .catch(() => {})
      await sleep(2_000, signal) // akış koptu: kısa bekleyip yeniden bağlan (yoksa 5 sn'lik yedek döngü işler)
    }
  }

  async function loop(signal: AbortSignal) {
    await Promise.all([pushLoop(signal), pollLoop(signal), watchLocal(signal)])
  }

  return { tick, loop, handle, flushAcks: () => acks }
}

/** Yerel sunucuya (Basic auth'lu) bağlanan basit HTTP istemcisi. */
export function httpLocal(base: string, password?: string, username = "sixfinger"): LocalApi {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const url = (path: string, q?: Record<string, string | number | undefined>) => {
    const u = new URL(path, base)
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
    return u
  }
  return {
    async get(path, query) {
      const res = await fetch(url(path, query), { headers })
      if (!res.ok) throw new Error(`${path} ${res.status}`)
      return (await res.json()) as never
    },
    async post(path, query, body) {
      const res = await fetch(url(path, query), { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) })
      if (!res.ok) throw new Error(`${path} ${res.status}`)
      return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as never
    },
    async events(onEvent, signal) {
      const res = await fetch(url("/global/event"), { headers: { ...headers, accept: "text/event-stream" }, signal })
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
      const reader = res.body.getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) return
        onEvent()
      }
    },
  }
}

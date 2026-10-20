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
  post(path: string, query: Record<string, string | undefined>, body?: unknown): Promise<void>
}

export interface Remote {
  server: string
  token: () => Promise<string>
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

  async function api<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${remote.server}/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await remote.token()}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
  }

  async function register() {
    const r = await api<{ deviceId: string }>("/link/register", { name, platform: `${os.platform()}-${os.arch()}`, version: process.env.SIXFINGER_VERSION ?? "" })
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

    const r = await api<{ commands: Array<{ id: string; sessionId: string; kind: string; payload: Json }> }>("/link/sync", { deviceId, sessions, gone })
    if (r.status === 404) {
      deviceId = undefined // sunucu cihazı unuttu (silinmiş): yeniden kaydol
      return { busy: true }
    }
    if (r.status !== 200) throw new Error(`sync ${r.status}`)
    for (const c of r.json.commands) {
      await run(c).catch((e) => log(`komut başarısız (${c.kind}): ${e instanceof Error ? e.message : String(e)}`))
      seen.delete(c.sessionId) // sonucu hızla göster
    }
    return { busy: anyBusy || r.json.commands.length > 0 }
  }

  async function run(c: { sessionId: string; kind: string; payload: Json }) {
    const directory = dirOf.get(c.sessionId)
    if (!directory) throw new Error("oturum yerelde yok")
    switch (c.kind) {
      case "prompt":
        return local.post(`/session/${c.sessionId}/prompt_async`, { directory }, { parts: [{ type: "text", text: String(c.payload.text ?? "") }] })
      case "abort":
        return local.post(`/session/${c.sessionId}/abort`, { directory })
      case "permission":
        return local.post(`/permission/${c.payload.requestId}/reply`, { directory }, { reply: c.payload.reply })
      case "question":
        return c.payload.reject
          ? local.post(`/question/${c.payload.requestId}/reject`, { directory })
          : local.post(`/question/${c.payload.requestId}/reply`, { directory }, { answers: c.payload.answers ?? [] })
    }
  }

  /** Döngü: iş varken 1 sn, boştayken 3 sn; hata olursa üstel bekleme. `signal` ile durur. */
  async function loop(signal: AbortSignal) {
    let backoff = 0
    while (!signal.aborted) {
      let wait = 3_000
      try {
        const { busy } = await tick()
        backoff = 0
        if (busy) wait = 1_000
      } catch (e) {
        backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000)
        wait = backoff
        log(`bağlantı sorunu: ${e instanceof Error ? e.message : String(e)} (${Math.round(wait / 1000)} sn sonra yeniden)`)
        if (e instanceof Login.LoginRequiredError) throw e
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait)
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
      })
    }
  }

  return { tick, loop }
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
    },
  }
}

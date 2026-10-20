import fs from "fs/promises"
import os from "os"
import path from "path"
import open from "open"
import { Global } from "@sixfinger/core/global"

/**
 * SixFinger hesabı girişi (cihaz kodu akışı). Parola ya da jeton elle girilmez: CLI bir kod alır, tarayıcıyı açar,
 * kullanıcı oturum açmış sitede kodu onaylar, CLI jetonları alır. Jetonlar yalnızca bu cihazda, 0600 izinli dosyada tutulur.
 */

/** Arayüz dili: sistem dili Türkçe ise Türkçe, değilse İngilizce (`SIXFINGER_LANG=tr|en` ile zorlanabilir). */
export const lang = (): "tr" | "en" => {
  const v = (process.env.SIXFINGER_LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "").toLowerCase()
  return v.startsWith("tr") ? "tr" : "en"
}

const M = {
  loginRequired: { tr: "SixFinger hesabına giriş yapılmamış. `sixfinger login` komutunu çalıştır.", en: "You are not signed in to SixFinger. Run `sixfinger login`." },
  refreshFailed: { tr: "SixFinger sunucusu oturumu yenileyemedi ({s}).", en: "The SixFinger server could not refresh your session ({s})." },
  startFailed: { tr: "Giriş başlatılamadı ({s}). Sunucu: {server}", en: "Could not start sign-in ({s}). Server: {server}" },
  need: { tr: "SixFinger hesabına giriş gerekli.", en: "Sign in to your SixFinger account." },
  opening: { tr: "  Tarayıcı açılıyor: {url}", en: "  Opening your browser: {url}" },
  manual: { tr: "  Açılmazsa adresi elle aç. Kod: {code}", en: "  If it does not open, visit the address manually. Code: {code}" },
  waiting: { tr: "  Onayı bekliyorum…", en: "  Waiting for approval…" },
  expired: { tr: "Kodun süresi doldu. Komutu yeniden çalıştır.", en: "The code expired. Run the command again." },
  signedIn: { tr: "Giriş yapıldı{who}.", en: "Signed in{who}." },
  timeout: { tr: "Giriş zaman aşımına uğradı. Komutu yeniden çalıştır.", en: "Sign-in timed out. Run the command again." },
} as const

export const tx = (k: keyof typeof M, vars: Record<string, string | number> = {}): string =>
  M[k][lang()].replace(/\{(\w+)\}/g, (_, n) => String(vars[n] ?? ""))

export const server = () => (process.env.SIXFINGER_SERVER ?? "https://chat.sixfinger.live").replace(/\/$/, "")

export interface Stored {
  access: string
  refresh: string
  /** Erişim jetonunun bitiş zamanı (ms). */
  expires: number
  user: { id: string; email?: string | null; displayName?: string | null }
}

interface AuthResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: Stored["user"]
}

export class LoginRequiredError extends Error {
  constructor() {
    super(tx("loginRequired"))
  }
}

const file = () => path.join(Global.Path.data, "sixfinger-auth.json")

export async function read(): Promise<Stored | undefined> {
  try {
    const s = JSON.parse(await fs.readFile(file(), "utf8")) as Stored
    return s.refresh ? s : undefined
  } catch {
    return undefined
  }
}

async function write(s: Stored) {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(s), { mode: 0o600 })
}

export async function clear() {
  await fs.rm(file(), { force: true })
}

export async function loggedIn(): Promise<boolean> {
  return Boolean(process.env.SIXFINGER_TOKEN) || Boolean(await read())
}

const fromResponse = (r: AuthResponse): Stored => ({
  access: r.accessToken,
  refresh: r.refreshToken,
  expires: Date.now() + r.expiresIn * 1000,
  user: r.user,
})

async function post<T>(p: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${server()}/api${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "sixfinger-code-cli" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T }
}

// Yenileme jetonu her kullanımda döner (rotasyon): aynı anda iki yenileme olmasın.
let refreshing: Promise<Stored> | undefined

function refresh(s: Stored): Promise<Stored> {
  refreshing ??= (async () => {
    try {
      const r = await post<AuthResponse>("/auth/refresh", { refreshToken: s.refresh })
      if (r.status === 401 || r.status === 403) {
        await clear()
        throw new LoginRequiredError()
      }
      if (r.status >= 400) throw new Error(tx("refreshFailed", { s: r.status }))
      const next = fromResponse(r.json)
      await write(next)
      return next
    } finally {
      refreshing = undefined
    }
  })()
  return refreshing
}

/** Geçerli erişim jetonu (süresi dolmuşsa yeniler). */
export async function accessToken(force = false): Promise<string> {
  if (process.env.SIXFINGER_TOKEN) return process.env.SIXFINGER_TOKEN
  const s = await read()
  if (!s) throw new LoginRequiredError()
  if (!force && s.expires - Date.now() > 30_000) return s.access
  return (await refresh(s)).access
}

/** Cihaz kodu girişi. `say`: kullanıcıya yazılacak satırlar (varsayılan stderr). */
export async function deviceLogin(say: (line: string) => void = (l) => process.stderr.write(l + "\n")): Promise<Stored> {
  const start = await post<{ deviceCode: string; userCode: string; verificationUrl: string; interval: number; expiresIn: number }>("/device/start", {
    client: `SixFinger Code CLI (${os.hostname()})`.slice(0, 60),
  })
  if (start.status !== 200) throw new Error(tx("startFailed", { s: start.status, server: server() }))
  const { deviceCode, userCode, verificationUrl, interval, expiresIn } = start.json
  say("")
  say(tx("need"))
  say(tx("opening", { url: verificationUrl }))
  say(tx("manual", { code: userCode }))
  say(tx("waiting"))
  open(verificationUrl).catch(() => {})
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, interval) * 1000))
    const r = await post<AuthResponse & { status: string }>("/device/poll", { deviceCode })
    if (r.status === 410) throw new Error(tx("expired"))
    if (r.status === 200 && r.json.status === "approved") {
      const s = fromResponse(r.json)
      await write(s)
      say(tx("signedIn", { who: s.user.email ? `: ${s.user.email}` : "" }))
      return s
    }
  }
  throw new Error(tx("timeout"))
}

/** Provider SDK'sına verilen fetch: her istekte güncel jetonu ekler, 401'de bir kez yenileyip tekrar dener. */
export async function sixfingerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const send = async (force: boolean) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${await accessToken(force)}`)
    return fetch(input, { ...init, headers })
  }
  const res = await send(false)
  if (res.status !== 401 || process.env.SIXFINGER_TOKEN) return res
  return send(true)
}

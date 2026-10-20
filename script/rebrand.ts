#!/usr/bin/env bun
/**
 * Yeniden markalama: "opencode" → "SixFinger Code". Tekrar çalıştırılabilir (idempotent): zaten dönüştürülmüş metne dokunmaz.
 *
 *   bun script/rebrand.ts            # uygular
 *   bun script/rebrand.ts --check    # kalan izleri listeler (CI denetimi); izin verilenler PROTECTED + ALLOWED_PATHS
 *
 * Korunanlar: üçüncü taraf paket/depo adları, henüz karar verilmemiş alan adı (opencode.ai), vendor paketi ve lisans atfı.
 */
import { $ } from "bun"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const isFile = (f: string) => existsSync(f) && lstatSync(f).isFile()
import { dirname } from "node:path"

const CHECK = process.argv.includes("--check")

/** Değişmeyecek ifadeler (üçüncü taraf adları, alan adı, vendor paketi). */
const PROTECTED: RegExp[] = [
  /opencode\.ai/g,
  /opencode-ai-client-[\w.-]*\.tgz/g,
  /@opencode-ai\/client/g,
  /opencode-(?:helicone-session|wakatime|gitlab-auth|gitlab-plugin|openai-codex-auth|gemini-auth|google-antigravity-auth|antigravity-auth|morph-plugin|plugin-template|brand-assets)/g,
  /opencode\.nvim/g,
  /sst\/opencode/g,
]

/** Sırayla uygulanan dönüşümler (özelden genele). */
const RULES: Array<[RegExp, string]> = [
  [/anomalyco\/tap\/opencode/g, "sixfingerdev/tap/sixfinger"],
  [/anomalyco\/opencode/g, "sixfingerdev/sixfinger-code"],
  [/anomalyco/g, "sixfingerdev"],
  [/@opencode-ai\//g, "@sixfinger/"],
  [/opencode-ai/g, "sixfinger-code"],
  [/OPENCODE/g, "SIXFINGER"],
  [/OpenCode/g, "SixFinger"],
  [/Opencode/g, "Sixfinger"],
  [/opencode/g, "sixfinger"],
]

/** Metinde gezilmeyecek yollar. */
const SKIP_PATH = /(^|\/)(node_modules|\.git)\/|\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|tgz|zip|gz|wasm|mp4|mov|pdf|svg|avif)$|(^|\/)LICENSE$|^script\/rebrand\.ts$/i

/** Kalan izlerin sorun sayılmadığı yollar (lisans atfı vb.). */
const ALLOWED_PATHS = /^(LICENSE|NOTICE|THIRD_PARTY.*|script\/rebrand\.ts|bun\.lock)$/

function protect(text: string): [string, string[]] {
  const saved: string[] = []
  for (const re of PROTECTED) {
    text = text.replace(re, (m) => {
      saved.push(m)
      return `\u0000P${saved.length - 1}\u0000`
    })
  }
  return [text, saved]
}
const restore = (text: string, saved: string[]) => text.replace(/\u0000P(\d+)\u0000/g, (_, i) => saved[Number(i)]!)

export function rewrite(text: string): string {
  const [t, saved] = protect(text)
  let out = t
  for (const [re, to] of RULES) out = out.replace(re, to)
  return restore(out, saved)
}

const files = (await $`git ls-files -z`.text()).split("\0").filter(Boolean)

if (CHECK) {
  const left: string[] = []
  for (const f of files) {
    if (ALLOWED_PATHS.test(f) || SKIP_PATH.test(f) || !isFile(f)) continue
    const raw = readFileSync(f)
    if (raw.includes(0)) continue
    const [t] = protect(raw.toString("utf8"))
    if (/opencode|anomalyco/i.test(t) || /opencode/i.test(f)) left.push(f)
  }
  if (left.length) {
    console.log(`${left.length} dosyada hâlâ "opencode" izi var:\n` + left.slice(0, 200).join("\n"))
    process.exit(1)
  }
  console.log("temiz")
  process.exit(0)
}

let changed = 0
for (const f of files) {
  if (SKIP_PATH.test(f) || !isFile(f)) continue
  const raw = readFileSync(f)
  if (raw.includes(0)) continue
  const src = raw.toString("utf8")
  const out = rewrite(src)
  if (out !== src) {
    writeFileSync(f, out)
    changed++
  }
}

// yollar (dosya/dizin adları)
let moved = 0
for (const f of files) {
  if (!existsSync(f)) continue
  const to = rewrite(f)
  if (to === f) continue
  mkdirSync(dirname(to), { recursive: true })
  await $`git mv -k ${f} ${to}`.quiet()
  moved++
}
console.log(`içerik değişen: ${changed}, taşınan yol: ${moved}`)

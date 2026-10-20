import { Effect } from "effect"
import { Identifier } from "@opencode-ai/core/id/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import path from "path"

/**
 * File-based memory storage: one memory is one markdown file with a
 * frontmatter header. Two scopes:
 *  - global: remembered in every session, across projects
 *  - session: remembered only while this session lives
 *
 * Every function takes the resolved FSUtil service as its first argument so
 * callers (tools, extractors) pay the layer cost once at init.
 */

export type Info = {
  id: string
  scope: "global" | "session"
  source: "model" | "auto"
  tags: string[]
  created: number
  updated: number
  content: string
}

export type Fs = typeof FSUtil.Service

const GLOBAL_DIR = () => path.join(Global.Path.state, "memory", "global")
const SESSION_DIR = (sessionID: string) => path.join(Global.Path.state, "memory", "session", sessionID)

const dirFor = (scope: "global" | "session", sessionID: string) =>
  scope === "global" ? GLOBAL_DIR() : SESSION_DIR(sessionID)

function frontmatter(info: { id: string; scope: string; source: string; tags: string[]; created: number; updated: number }) {
  return [
    "---",
    `id: ${info.id}`,
    `scope: ${info.scope}`,
    `source: ${info.source}`,
    `tags: ${info.tags.join(",")}`,
    `created: ${info.created}`,
    `updated: ${info.updated}`,
    "---",
  ].join("\n")
}

function parseFile(name: string, raw: string): Info | undefined {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)
  if (!match) return undefined
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split("\n")) {
    const sep = line.indexOf(": ")
    if (sep > 0) fields[line.slice(0, sep)] = line.slice(sep + 2)
  }
  const content = match[2].trim()
  if (!content) return undefined
  return {
    id: fields.id || name.replace(/\.md$/, ""),
    scope: fields.scope === "session" ? "session" : "global",
    source: fields.source === "auto" ? "auto" : "model",
    tags: (fields.tags ?? "").split(",").filter(Boolean),
    created: Number(fields.created) || 0,
    updated: Number(fields.updated) || 0,
    content,
  }
}

export const save = Effect.fn("MemoryStore.save")(function* (input: {
  fsys: FSUtil.Interface
  scope: "global" | "session"
  sessionID: string
  content: string
  source?: "model" | "auto"
  tags?: string[]
}) {
  const now = Date.now()
  const id = Identifier.ascending("memory")
  const info: Info = {
    id,
    scope: input.scope,
    source: input.source ?? "model",
    tags: input.tags ?? [],
    created: now,
    updated: now,
    content: input.content.trim(),
  }
  yield* input.fsys
    .writeWithDirs(
      path.join(dirFor(info.scope, input.sessionID), `${id}.md`),
      `${frontmatter(info)}\n\n${info.content}\n`,
    )
    .pipe(Effect.orDie)
  return id
})

export const list = Effect.fn("MemoryStore.list")(function* (input: {
  fsys: FSUtil.Interface
  sessionID: string
}) {
  const result: Info[] = []
  const dirs = [GLOBAL_DIR(), SESSION_DIR(input.sessionID)]
  for (const dir of dirs) {
    const exists = yield* input.fsys.existsSafe(dir).pipe(Effect.orDie)
    if (!exists) continue
    const entries = yield* input.fsys.readDirectoryEntries(dir).pipe(Effect.orDie)
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
      const raw = yield* input.fsys.readFileStringSafe(path.join(dir, entry.name)).pipe(Effect.orDie)
      const parsed = raw ? parseFile(entry.name.replace(/\.md$/, ""), raw) : undefined
      if (parsed) result.push(parsed)
    }
  }
  return result.toSorted((a, b) => b.updated - a.updated)
})

export const remove = Effect.fn("MemoryStore.remove")(function* (input: {
  fsys: FSUtil.Interface
  sessionID: string
  id: string
  scope?: "global" | "session"
}) {
  for (const [scope, dir] of [
    ["session", SESSION_DIR(input.sessionID)],
    ["global", GLOBAL_DIR()],
  ] as const) {
    if (input.scope && input.scope !== scope) continue
    const file = path.join(dir, `${input.id}.md`)
    if (!(yield* input.fsys.existsSafe(file).pipe(Effect.orDie))) continue
    yield* input.fsys.remove(file).pipe(Effect.ignore)
    return true
  }
  return false
})

export const update = Effect.fn("MemoryStore.update")(function* (input: {
  fsys: FSUtil.Interface
  sessionID: string
  id: string
  content: string
}) {
  for (const dir of [SESSION_DIR(input.sessionID), GLOBAL_DIR()]) {
    const file = path.join(dir, `${input.id}.md`)
    if (!(yield* input.fsys.existsSafe(file).pipe(Effect.orDie))) continue
    const raw = yield* input.fsys.readFileStringSafe(file).pipe(Effect.orDie)
    const parsed = raw ? parseFile(input.id, raw) : undefined
    if (!parsed) continue
    const updated: Info = { ...parsed, content: input.content.trim(), updated: Date.now() }
    yield* input.fsys.writeWithDirs(file, `${frontmatter(updated)}\n\n${updated.content}\n`).pipe(Effect.orDie)
    return true
  }
  return false
})

export * as MemoryStore from "./memory-store"

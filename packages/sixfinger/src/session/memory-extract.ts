export * as MemoryExtract from "./memory-extract"

import { Stream } from "effect"
import { SessionV1 } from "@sixfinger/core/v1/session"
import { Effect, Exit, Schema } from "effect"
import { LLM } from "./llm"
import { MemoryStore } from "./memory-store"
import { FSUtil } from "@sixfinger/core/fs-util"
import { SessionID } from "./schema"
import type { Provider } from "@/provider/provider"

const EXTRACTION_PROMPT = [
  "You are a memory extractor. Read the conversation excerpt and decide whether it contains any DURABLE facts worth remembering for future sessions.",
  "",
  "Worth remembering: user preferences (tools, style, workflow), project facts (stack, commands, architecture), and decisions with lasting effect.",
  "NOT worth remembering: transient task state, one-off details, anything already stale, secrets or credentials.",
  "",
  "Return between 0 and 3 memories as a JSON array of objects with a `content` string (one self-contained fact, short, with enough context to make sense later) and optional `tags` string array.",
  'Example: [{"content":"In this project, tests run with bun test from the package directory","tags":["project","testing"]}]',
  "If nothing is worth remembering, return [].",
  "Return ONLY the JSON array, no prose, no code fences.",
].join("\n")

const Candidates = Schema.Array(
  Schema.Struct({
    content: Schema.String,
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
)

function dedupe(existing: MemoryStore.Info[], incoming: { content: string; tags?: readonly string[] }[]) {
  return incoming.filter((candidate) => {
    const normalized = candidate.content.toLowerCase().replace(/\s+/g, " ").trim()
    if (normalized.length < 8) return false
    return !existing.some((memory) => {
      const known = memory.content.toLowerCase().replace(/\s+/g, " ").trim()
      return known.includes(normalized) || normalized.includes(known)
    })
  })
}

/** Runs an extraction pass with the SAME model the session is using. Returns
 * how many memories were saved (0 when nothing new or the call failed). */
export const extract = Effect.fn("MemoryExtract.extract")(function* (input: {
  sessionID: SessionID
  model: Provider.Model
  llm: LLM.Interface
  fsys: FSUtil.Interface
  messages: SessionV1.WithParts[]
}) {
  const excerpt = input.messages
    .slice(-10)
    .map((message) => {
      const role = message.info.role
      const texts = message.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic !== true)
        .map((part) => part.text)
      return `<${role}>${texts.join("\n").slice(0, 2000)}</${role}>`
    })
    .join("\n\n")
  if (!excerpt.trim()) return 0

  const lastUser = [...input.messages].reverse().find((msg) => msg.info.role === "user")
  if (!lastUser) return 0

  let response = ""
  yield* input.llm
    .stream({
      user: lastUser.info as SessionV1.User,
      sessionID: input.sessionID,
      model: input.model,
      agent: {
        name: "memory",
        description: "Memory extractor",
        options: {},
        mode: "primary",
        permission: [],
      },
      system: [EXTRACTION_PROMPT],
      messages: [{ role: "user" as const, content: excerpt }],
      tools: {},
      toolChoice: "none",
    })
    .pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "text-delta") response += event.text
        }),
      ),
      Effect.ignore,
    )

  const raw = response
    .trim()
    .replace(/^```(?:json)?\n?|\n?```$/g, "")
    .trim()
  if (!raw.startsWith("[")) return 0
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return 0
  }
  const parsed = Schema.decodeUnknownExit(Candidates)(json)
  if (!Exit.isSuccess(parsed)) return 0
  const candidates = dedupe(
    yield* MemoryStore.list({ fsys: input.fsys, sessionID: input.sessionID }),
    [...parsed.value],
  )
  let saved = 0
  for (const candidate of candidates.slice(0, 3)) {
    yield* MemoryStore.save({
      fsys: input.fsys,
      scope: "global",
      sessionID: input.sessionID,
      content: candidate.content,
      source: "auto",
      tags: candidate.tags ? [...candidate.tags] : undefined,
    })
    saved++
  }
  return saved
})

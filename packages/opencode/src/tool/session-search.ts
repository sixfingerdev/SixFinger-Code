import * as Tool from "./tool"
import DESCRIPTION from "./session-search.txt"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/schema/v1/session"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

const CONTEXT_CHARS = 150
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const ROW_CAP = 5000

export const Parameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description:
      "What to search for: plain text (case-insensitive) or a regex pattern when is_regex is true. A function name, file path, error string, config key, or decision keyword. Optional when message_id is set — that reads the full message instead.",
  }),
  is_regex: Schema.optional(Schema.Boolean).annotate({
    description:
      "Treat query as a JavaScript regex instead of plain text. Use for structural patterns like apiKey\\s*[:=] or (error|failed).{0,40}cache.",
  }),
  scope: Schema.optional(Schema.Literals(["current", "all"])).annotate({
    description:
      'current: only this session. all: every session in the database — use when the detail might predate this conversation ("what did we decide last week?"). Default: current.',
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`,
  }),
  role: Schema.optional(Schema.Literals(["user", "assistant"])).annotate({
    description:
      'Only search messages with this role. "user" finds what the user asked or decided; "assistant" finds what was implemented or reported. Default: both.',
  }),
  context: Schema.optional(Schema.Number).annotate({
    description: `Characters shown around each match. Default ${CONTEXT_CHARS}, maximum 2000. Raise it (or use message_id) when a snippet is not enough to judge the match.`,
  }),
  message_id: Schema.optional(Schema.String).annotate({
    description:
      "Read a specific message in full instead of searching. Use after a search matched something interesting: this dumps every part of that message (full text, tool outputs, attachments) so you can judge it in context.",
  }),
})

type Match = {
  messageID: string
  sessionID: string
  role: string
  created: number
  partID: string
  partType: string
  compacted: boolean
  text: string
}

function textsOf(part: SessionV1.Part): { texts: string[]; compacted: boolean } {
  if (part.type === "text") {
    // Skip model-internal injections (system reminders, job markers); they are
    // not part of the conversation history users want recovered.
    if (part.synthetic === true || part.ignored === true) return { texts: [], compacted: false }
    return { texts: part.text ? [part.text] : [], compacted: false }
  }
  if (part.type === "reasoning") {
    return { texts: part.text ? [part.text] : [], compacted: false }
  }
  if (part.type === "tool") {
    if (part.state.status !== "completed") return { texts: [], compacted: false }
    // The raw output stays in the database even when the part was compacted;
    // that original content is exactly what this search exists to recover.
    const texts = [part.state.output]
    for (const attachment of part.state.attachments ?? []) {
      if (attachment.source?.type === "file") texts.push(attachment.source.text.value)
    }
    return { texts: texts.filter((text) => Boolean(text)), compacted: part.state.time.compacted !== undefined }
  }
  if (part.type === "file") {
    return {
      texts: [part.filename ?? "", ...(part.source?.type === "file" ? [part.source.text.value] : [])].filter(
        (text) => Boolean(text),
      ),
      compacted: false,
    }
  }
  return { texts: [], compacted: false }
}

function snippet(text: string, index: number, length: number, contextChars: number) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(text.length, index + length + contextChars)
  const left = start > 0 ? "..." : ""
  const right = end < text.length ? "..." : ""
  return `${left}${text.slice(start, end).replaceAll("\n", " ").trim()}${right}`
}

function firstMatch(text: string, pattern: RegExp): { index: number; length: number } | undefined {
  const found = pattern.exec(text)
  if (!found) return undefined
  return { index: found.index, length: found[0].length || 1 }
}

export const SessionSearchTool = Tool.define(
  "session_search",
  Effect.gen(function* () {
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Full-message read: after a search pins down an interesting hit,
          // re-run with its message_id to see everything that message holds.
          if (params.message_id) {
            const { db } = database
            const messageRow = yield* db
              .select({ id: MessageTable.id, sessionID: MessageTable.session_id, created: MessageTable.time_created, data: MessageTable.data })
              .from(MessageTable)
              .where(eq(MessageTable.id, params.message_id as never))
              .get()
              .pipe(Effect.orDie)
            if (!messageRow) {
              const output = `No message found with id "${params.message_id}". Copy the message_id exactly from a previous search result.`
              return { title: `Not found: ${params.message_id}`, metadata: { output }, output }
            }
            const parts = yield* db
              .select({ partID: PartTable.id, partData: PartTable.data })
              .from(PartTable)
              .where(eq(PartTable.message_id, params.message_id as never))
              .orderBy(PartTable.id)
              .all()
              .pipe(Effect.orDie)
            const role = (messageRow.data as { role?: string }).role ?? "unknown"
            const blocks = parts.flatMap((part) => {
              const data = part.partData as SessionV1.Part
              if (!data || typeof data !== "object" || !("type" in data)) return []
              const { texts, compacted } = textsOf(data)
              return texts.map(
                (text) =>
                  `<part id="${part.partID}" type="${data.type}"${compacted ? ' compacted="true"' : ""}>\n${text}\n</part>`,
              )
            })
            const output = [
              `<message id="${messageRow.id}" session="${messageRow.sessionID}" role="${role}" time="${new Date(messageRow.created).toISOString()}" parts="${blocks.length}">`,
              ...blocks,
              `</message>`,
              "",
              blocks.length === 0
                ? "This message has no searchable text (it may hold only non-text parts like snapshots or compaction markers)."
                : `Full content of ${blocks.length} part(s). Compacted parts show the ORIGINAL content.`,
            ].join("\n")
            return { title: `Message ${messageRow.id}`, metadata: { output }, output }
          }

          if (!params.query) {
            return yield* Effect.fail(
              new Error("Provide a query to search, or a message_id to read a message in full."),
            )
          }

          const matcher = yield* Effect.try({
            try: () => {
              if (params.query === undefined) return new RegExp("$^")
              return params.is_regex
                ? new RegExp(params.query, "i")
                : new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
            },
            catch: (error) =>
              new Error(
                `Invalid regex: "${params.query}". ${error instanceof Error ? error.message : String(error)}`,
              ),
          })
          const limit = Math.min(Math.max(Math.floor(params.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
          const contextChars = Math.min(Math.max(Math.floor(params.context ?? CONTEXT_CHARS), 0), 2000)
          const scopeSession = params.scope === "all" ? undefined : ctx.sessionID
          const { db } = database

          const query = db
            .select({
              messageID: MessageTable.id,
              sessionID: MessageTable.session_id,
              created: MessageTable.time_created,
              messageData: MessageTable.data,
              partID: PartTable.id,
              partData: PartTable.data,
            })
            .from(PartTable)
            .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
            .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
            .limit(ROW_CAP)
          const rows = yield* (scopeSession
            ? query.where(and(eq(PartTable.session_id, scopeSession)))
            : query
          )
            .all()
            .pipe(
              Effect.orDie,
            )

          const matches: Match[] = []
          for (const row of rows) {
            if (matches.length >= limit) break
            const role = (row.messageData as { role?: string }).role ?? ""
            if (role !== "user" && role !== "assistant") continue
            if (params.role && params.role !== role) continue
            const part = row.partData as SessionV1.Part
            if (!part || typeof part !== "object" || !("type" in part)) continue
            const { texts, compacted } = textsOf(part)
            for (const text of texts) {
              const found = firstMatch(text, matcher)
              if (!found) continue
              matches.push({
                messageID: row.messageID,
                sessionID: row.sessionID,
                role,
                created: row.created,
                partID: row.partID,
                partType: part.type,
                compacted,
                text: snippet(text, found.index, found.length, contextChars),
              })
              break
            }
          }

          if (matches.length === 0) {
            const scopeLabel = params.scope === "all" ? "across all sessions" : "in this session"
            const output = `No matches for ${params.is_regex ? `regex "${params.query}"` : `"${params.query}"`} ${scopeLabel}. Try a different pattern, widen scope to "all", or drop the role filter.`
            return { title: `No matches: ${params.query}`, metadata: { output }, output }
          }

          const sessionLabel = (sessionID: string) => (params.scope === "all" ? ` session="${sessionID}"` : "")
          const output = [
            `<session_search query="${params.query}" matches="${matches.length}"${params.is_regex ? ' mode="regex"' : ""}>`,
            ...matches.map(
              (match) =>
                `<result message_id="${match.messageID}"${sessionLabel(match.sessionID)} role="${match.role}" time="${new Date(match.created).toISOString()}" part="${match.partType}"${match.compacted ? ' compacted="true"' : ""}>\n${match.text}\n</result>`,
            ),
            `</session_search>`,
            "",
            `Found ${matches.length} match(es) for "${params.query}". Compacted results show the ORIGINAL content, not the "[compacted]" placeholder. Raise "limit" if results look truncated.`,
          ].join("\n")
          return { title: `${matches.length} match(es): ${params.query}`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { MemoryStore } from "@/session/memory-store"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Effect, Schema } from "effect"

const id = "memory"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["save", "list", "update", "delete"]).annotate({
    description: "save: record a memory. list: see what is remembered. update: rewrite one. delete: remove one.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description:
      "Memory text. Required for save and update. One fact, self-contained, with enough context to make sense months later.",
  }),
  scope: Schema.optional(Schema.Literals(["session", "global"])).annotate({
    description:
      'save only. "global" = for every time: remembered in every session across projects. "session" = for this session only. Default: session.',
  }),
  tags: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional labels for save (for example preference, project, decision).",
  }),
  memory_id: Schema.optional(Schema.String).annotate({
    description: "Memory ID from list. Required for update and delete.",
  }),
})

export const MemoryTool = Tool.define<typeof Parameters, { output: string }, FSUtil.Service>(
  id,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "save") {
            if (!params.content?.trim()) {
              return yield* Effect.fail(new Error('content is required for action "save".'))
            }
            const scope = params.scope ?? "session"
            const memoryID = yield* MemoryStore.save({
              fsys,
              scope,
              sessionID: ctx.sessionID,
              content: params.content,
              tags: params.tags,
            })
            const output = `Saved ${scope} memory ${memoryID}${scope === "global" ? " (remembered in every session)" : " (remembered for this session)"}.`
            return { title: `Memory saved (${scope})`, metadata: { output }, output }
          }

          if (params.action === "list") {
            const memories = yield* MemoryStore.list({ fsys, sessionID: ctx.sessionID })
            const filtered = params.content
              ? memories.filter(
                  (memory) =>
                    memory.content.toLowerCase().includes(params.content!.toLowerCase()) ||
                    memory.tags.some((tag) => tag.toLowerCase().includes(params.content!.toLowerCase())),
                )
              : memories
            if (filtered.length === 0) {
              const output = "No memories stored yet."
              return { title: "No memories", metadata: { output }, output }
            }
            const lines = filtered.map(
              (memory) =>
                `- [${memory.scope}/${memory.source}${memory.tags.length ? `/${memory.tags.join("|")}` : ""}] ${memory.id}: ${memory.content}`,
            )
            const output = [`<memories count="${filtered.length}">`, ...lines, `</memories>`].join("\n")
            return { title: `${filtered.length} memor(ies)`, metadata: { output }, output }
          }

          if (params.action === "update") {
            if (!params.memory_id) throw new Error('memory_id is required for action "update".')
            if (!params.content) throw new Error('content is required for action "update".')
            const ok = yield* MemoryStore.update({
              fsys,
              sessionID: ctx.sessionID,
              id: params.memory_id,
              content: params.content ?? "",
            })
            if (!ok) throw new Error(`Unknown memory: "${params.memory_id}".`)
            const output = `Memory ${params.memory_id} updated.`
            return { title: "Memory updated", metadata: { output }, output }
          }

          if (!params.memory_id) throw new Error('memory_id is required for action "delete".')
          const ok = yield* MemoryStore.remove({ fsys, sessionID: ctx.sessionID, id: params.memory_id, scope: params.scope })
          if (!ok) throw new Error(`Unknown memory: "${params.memory_id}".`)
          const output = `Memory ${params.memory_id} deleted.`
          return { title: "Memory deleted", metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

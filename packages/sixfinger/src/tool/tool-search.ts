import * as Tool from "./tool"
import DESCRIPTION from "./tool-search.txt"
import { Effect, Schema } from "effect"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Capability keyword or tool name fragment, for example \"lsp\", \"diagnostics\", or \"planning\".",
  }),
})

export type SearchFn = (input: { query: string }) => Effect.Effect<{ matched: string[]; enabled: string[] }>

export const create = (search: SearchFn) =>
  Tool.define(
    "tool_search",
    Effect.succeed({
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const result = yield* search({ query: params.query })
          if (result.matched.length === 0) {
            const output = `No hidden tools match "${params.query}". The tools currently available to you are all you have for this task.`
            return { title: `No matches: ${params.query}`, metadata: { output }, output }
          }
          const output = [
            `<tool_search query="${params.query}" enabled="${result.enabled.length}">`,
            ...result.matched.map((id) => `  <tool>${id}</tool>`),
            `</tool_search>`,
            "",
            `Activated ${result.enabled.length} tool(s): ${result.enabled.join(", ")}. They are now available for the rest of the session — call them directly.`,
          ].join("\n")
          return { title: `Activated: ${result.enabled.join(", ")}`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }),
  )

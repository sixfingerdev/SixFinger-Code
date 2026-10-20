import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Login from "../sixfinger/login"
import DESCRIPTION from "./websearch.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["sixfinger", "exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

/** Web araması tek sağlayıcıdan gelir: SixFinger sunucusu. (Eski Exa/Parallel seçimi kaldırıldı.) */
export function selectWebSearchProvider(_sessionID?: string, _flags?: unknown): WebSearchProvider {
  return "sixfinger"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

/** Web araması SixFinger sunucusundan geçer (kendi aramamız); dış arama hizmetlerine (Exa, Parallel) gidilmez. */
function callServer(params: Schema.Schema.Type<typeof Parameters>) {
  return Effect.tryPromise({
    try: async () => {
      const res = await Login.sixfingerFetch(`${Login.server()}/api/llm/v1/web_search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: params.query, limit: Math.min(10, Math.max(1, Math.round(params.numResults || 8))) }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok) throw new Error(`web search failed (${res.status})`)
      const j = (await res.json()) as { results?: Array<{ title: string; url: string; snippet?: string }> }
      const results = j.results ?? []
      if (results.length === 0) return undefined
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n")
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider: WebSearchProvider = "sixfinger"
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const result = yield* callServer(params)

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

import type { ModelsDev } from "@sixfinger/core/models-dev"

/**
 * SixFinger Code'un tek sağlayıcısı: kendi sunucumuz (OpenAI uyumlu uç). Model seçimi yalnızca iki moddur:
 * Hızlı ve Derin. Hangi gerçek modelin kullanıldığı sunucuda belirlenir; kredi de orada ölçülür.
 * BYOK, üçüncü taraf sağlayıcılar ve models.dev kataloğu bilerek yok.
 */
export const SIXFINGER_PROVIDER_ID = "sixfinger"

export const SIXFINGER_API_URL = `${(process.env.SIXFINGER_SERVER ?? "https://chat.sixfinger.live").replace(/\/$/, "")}/api/llm/v1`

const model = (id: string, name: string, context: number, output: number): ModelsDev.Model => ({
  id,
  name,
  release_date: "2026-10-01",
  attachment: true,
  reasoning: true,
  temperature: true,
  tool_call: true,
  limit: { context, output },
  modalities: { input: ["text", "image"], output: ["text"] },
})

export const sixfingerProvider = (apiUrl: string | undefined): ModelsDev.Provider => ({
  id: SIXFINGER_PROVIDER_ID,
  name: "SixFinger",
  env: ["SIXFINGER_TOKEN"],
  npm: "@ai-sdk/openai-compatible",
  api: apiUrl || SIXFINGER_API_URL,
  models: {
    fast: model("fast", "Hızlı", 128_000, 16_000),
    deep: model("deep", "Derin", 128_000, 32_000),
  },
})

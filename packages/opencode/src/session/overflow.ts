import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CompactionWindow } from "@opencode-ai/core/session/window"
import { CompactionSetting } from "@/session/compaction-setting"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0
  const cap = input.model.limit.input ?? context
  const output = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)

  // An explicitly configured reserved buffer wins over the window setting.
  if (input.cfg.compaction?.reserved !== undefined) {
    return Math.max(0, cap - input.cfg.compaction.reserved)
  }

  return CompactionWindow.resolve(CompactionSetting.get(), {
    context,
    input: input.model.limit.input,
    output,
  })
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

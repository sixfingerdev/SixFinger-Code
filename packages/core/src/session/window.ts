export * as CompactionWindow from "./window"

/**
 * Auto-compact window presets. The threshold is the token count at which
 * auto-compaction triggers; it never exceeds the model's context cap.
 *
 * - "auto-low"    compacts early: small working context, cheapest per-turn
 * - "auto-medium" balanced
 * - "auto-max"    compacts as late as safely possible (recommended)
 * - number        manual token window, capped to the model's context
 */
export type Window = "auto-low" | "auto-medium" | "auto-max" | number

export const DEFAULT: Window = "auto-max"

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export type ModelLimits = {
  context: number
  input?: number
  output?: number
}

/**
 * The latest safe threshold for a model: leaves room for one final response
 * plus its tool results, and for the compact request itself.
 */
/**
 * The latest safe threshold for a model: reserves headroom for the next turn
 * (response + tool results) before the request would overflow. The reserve is
 * a slice of the cap, capped by the output budget — large output limits (e.g.
 * 128k of a 272k input cap) do not halve the usable window.
 */
/**
 * The latest safe threshold for a model: reserves one final response's worth
 * of headroom (capped at 32k — the largest typical single response budget)
 * before the next request would overflow.
 */
export function maxThreshold(limits: ModelLimits): number {
  const cap = limits.input ?? limits.context
  const output = limits.output ?? 0
  const reserve = Math.min(output, 32_000)
  return clamp(cap - reserve, 16_000, cap)
}

export function lowThreshold(limits: ModelLimits): number {
  return clamp(Math.floor(limits.context * 0.25), 64_000, maxThreshold(limits))
}

export function mediumThreshold(limits: ModelLimits): number {
  return clamp(Math.floor(limits.context * 0.55), 96_000, maxThreshold(limits))
}

/** Effective token threshold for a window setting against a model. */
export function resolve(window: Window, limits: ModelLimits): number {
  if (typeof window === "number") return clamp(Math.floor(window), 16_000, limits.context)
  if (window === "auto-low") return lowThreshold(limits)
  if (window === "auto-medium") return mediumThreshold(limits)
  return maxThreshold(limits)
}

/** Human label used by the TUI dialog. */
export function label(window: Window): string {
  if (typeof window === "number") return `${Math.round(window / 1000)}k tokens`
  if (window === "auto-low") return "auto · low"
  if (window === "auto-medium") return "auto · medium"
  return "auto · max"
}

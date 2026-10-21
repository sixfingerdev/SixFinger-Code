import { registerCustomTheme } from "@pierre/diffs"
import { SixFingerTheme } from "./marked-theme"

let registered = false

export function registerSixFingerTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("SixFinger", () => Promise.resolve(SixFingerTheme))
}

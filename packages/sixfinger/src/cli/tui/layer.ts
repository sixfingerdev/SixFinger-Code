import { run as runTui, type TuiInput } from "@sixfinger/tui"
import { Global } from "@sixfinger/core/global"
import { AppNodeBuilder } from "@sixfinger/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

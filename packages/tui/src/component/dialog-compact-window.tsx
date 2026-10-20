import { createMemo } from "solid-js"
import { CompactionWindow } from "@opencode-ai/core/session/window"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { Locale } from "../util/locale"

const OPTIONS = [
  { window: "auto-low" as const, title: "auto · low", description: "smaller context, compacts early" },
  { window: "auto-medium" as const, title: "auto · medium", description: "balanced" },
  { window: "auto-max" as const, title: "auto · max", description: "recommended — compacts as late as safely possible" },
  { window: 100_000, title: "100k tokens" },
  { window: 200_000, title: "200k tokens" },
  { window: 300_000, title: "300k tokens" },
  { window: 400_000, title: "400k tokens" },
  { window: 500_000, title: "500k tokens" },
  { window: 600_000, title: "600k tokens" },
  { window: 700_000, title: "700k tokens" },
  { window: 800_000, title: "800k tokens" },
  { window: 900_000, title: "900k tokens" },
  { window: 1_000_000, title: "1m tokens" },
]

type Option = (typeof OPTIONS)[number]["window"]

export function DialogCompactWindow() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()

  const current = () => sync.data.compaction_window

  // Effective threshold preview against the current model, so the dialog
  // shows where compaction would actually trigger.
  const model = createMemo(() => {
    const last = Object.values(sync.data.message)
      .flat()
      .findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    return last
      ? sync.data.provider.find((provider) => provider.id === last.providerID)?.models[last.modelID]
      : undefined
  })

  const preview = (window: CompactionWindow.Window) => {
    const limits = model()
    if (!limits?.limit.context) return undefined
    const threshold = CompactionWindow.resolve(window, {
      context: limits.limit.context,
      input: limits.limit.input,
      output: limits.limit.output,
    })
    return `${Locale.number(threshold)} tokens`
  }

  const options = createMemo(() =>
    OPTIONS.map((option) => ({
      value: option.window,
      title:
        option.title +
        (typeof option.window === "number" && model()?.limit.context
          ? option.window > model()!.limit.context!
            ? ` (capped to ${Locale.number(model()!.limit.context!)})`
            : ""
          : ""),
      description:
        (option.description ?? "") +
        (preview(option.window) ? ` · compacts at ~${preview(option.window)}` : "") +
        (current() === option.window ? " · current" : ""),
      onSelect: () => {
        dialog.clear()
        void sdk.client.config.compaction
          .set({ window: option.window, workspace: project.workspace.current() })
          .then((result) => {
            sync.set("compaction_window", result.data!.window)
            toast.show({
              message: `Auto-compact window: ${CompactionWindow.label(result.data!.window)}`,
              variant: "info",
            })
          })
      },
    })),
  )

  return <DialogSelect<CompactionWindow.Window> title="Auto-compact window" current={current()} options={options()} />
}

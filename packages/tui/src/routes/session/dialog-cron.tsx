import { createMemo, createResource, createSignal, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useDialog } from "../../ui/dialog"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import type { ExperimentalCronEntry } from "@sixfinger/sdk/v2"

export function DialogCron() {
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [loadError, setLoadError] = createSignal<unknown>()

  onMount(() => {
    dialog.setSize("large")
  })

  const [entries, { refetch }] = createResource(() =>
    sdk.client.experimental.cron
      .list({ workspace: project.workspace.current() }, { throwOnError: true })
      .then((result) => result.data ?? [])
      // Catch so the rejected resource never reaches the memos below: reading
      // entries() in an errored state re-throws and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const options = createMemo(() => {
    if (showError()) return []
    const listed = entries()
    if (listed === undefined) {
      return [
        {
          title: "Loading scheduled tasks…",
          value: "loading",
          onSelect: () => {},
        },
      ]
    }

    if (listed.length === 0) {
      return [
        {
          title: "No scheduled tasks",
          value: "empty",
          onSelect: () => {},
        },
      ]
    }

    return listed.map((item: ExperimentalCronEntry) => ({
      title: item.enabled ? item.name : `${item.name} (off)`,
      value: item.id,
      footer: `every ${item.schedule} · next ${Locale.time(Number(item.nextRun))}${item.osScheduled ? " · os-scheduled" : ""}`,
      onSelect: async () => {
        await sdk.client.experimental.cron
          .delete({ cronID: item.id, workspace: project.workspace.current() }, { throwOnError: true })
          .catch((error) => {
            toast.show({ message: `Could not delete ${item.name}: ${errorMessage(error)}`, variant: "error" })
            throw error
          })
        toast.show({ message: `Deleted ${item.name}`, variant: "info" })
        setLoadError(undefined)
        await refetch()
      },
    }))
  })

  return (
    <DialogSelect<string>
      title="Scheduled tasks"
      options={options()}
      renderFilter={!showError()}
      locked={showError()}
      emptyView={
        showError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Could not load scheduled tasks
            </text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : undefined
      }
    />
  )
}

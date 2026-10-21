import { createMemo } from "solid-js"
import type { AssistantMessage, Message, TextPart } from "@sixfinger/sdk/v2"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { Locale } from "../util/locale"

/**
 * Pick a user message to compact everything BEFORE it; the message itself and
 * everything after stays verbatim in the working context.
 */
export function DialogCompactFrom(props: { sessionID: string; onModelPick: () => void }) {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()

  const candidates = createMemo(() =>
    (sync.data.message[props.sessionID] ?? [])
      .filter((message: Message) => message.role === "user")
      .filter((message: Message) => {
        const parts = sync.data.part[message.id] ?? []
        return parts.some((part): part is TextPart => part.type === "text" && part.synthetic !== true)
      })
      .slice(-50)
  )

  return (
    <DialogSelect<string>
      title="Compact from here — everything before the selection is summarized"
      options={candidates().map((message) => {
        const parts = sync.data.part[message.id] ?? []
        const preview =
          parts.find((part): part is TextPart => part.type === "text" && part.synthetic !== true)?.text.slice(0, 80) ??
          message.id
        return {
          value: message.id,
          title: preview.length >= 80 ? `${preview}…` : preview,
          description: Locale.todayTimeOrDateTime(message.time.created),
          onSelect: () => {
            dialog.clear()
            props.onModelPick()
            void (async () => {
              try {
                // Compact runs with the session's last-used model.
                const last = (sync.data.message[props.sessionID] ?? []).findLast(
                  (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
                )
                if (!last) {
                  toast.show({ message: "No model used yet in this session", variant: "warning" })
                  return
                }
                await sdk.client.session.summarize({
                  sessionID: props.sessionID,
                  providerID: last.providerID,
                  modelID: last.modelID,
                  from: message.id as never,
                  workspace: project.workspace.current(),
                })
                toast.show({ message: "Partial compaction started", variant: "info" })
              } catch (error) {
                toast.show({
                  message: error instanceof Error ? error.message : "Partial compaction failed",
                  variant: "error",
                })
              }
            })()
          },
        }
      })}
    />
  )
}

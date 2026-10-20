import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { useTuiConfig } from "../../config"
import { useBindings, useCommandShortcut } from "../../keymap"
import { Spinner } from "../../component/spinner"

function Editor(props: {
  sessionID: string
  messageID: string
  text: string
  thinking: string
  hasText: boolean
  hasThinking: boolean
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [busy, setBusy] = createSignal(false)
  const [field, setField] = createSignal<"text" | "thinking">(props.hasText ? "text" : "thinking")
  let textArea: TextareaRenderable | undefined
  let thinkingArea: TextareaRenderable | undefined

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      if (props.hasText && props.hasThinking) return
      const target = field() === "text" ? textArea : thinkingArea
      if (!target || target.isDestroyed) return
      target.focus()
      target.gotoLineEnd()
    }, 1)
  })

  function switchField() {
    if (busy()) return
    setField((current) => {
      const next = current === "text" ? "thinking" : "text"
      const target = next === "text" ? textArea : thinkingArea
      setTimeout(() => {
        if (!target || target.isDestroyed) return
        target.focus()
        target.gotoLineEnd()
      }, 1)
      return next
    })
  }

  async function save() {
    if (busy()) return
    setBusy(true)
    try {
      const status = sync.data.session_status?.[props.sessionID]
      if (status && status.type !== "idle") {
        await sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
      }
      const parts = sync.data.part[props.messageID] ?? []
      const texts = parts.filter((part): part is TextPart => part.type === "text" && !part.synthetic)
      const thinkings = parts.filter((part): part is ReasoningPart => part.type === "reasoning")
      const newText = textArea?.plainText ?? props.text
      const newThinking = thinkingArea?.plainText ?? props.thinking

      const [firstText, ...restText] = texts
      if (firstText && newText !== firstText.text) {
        await sdk.client.part.update({
          sessionID: props.sessionID,
          messageID: props.messageID,
          partID: firstText.id,
          part: { ...firstText, text: newText },
        })
      }
      for (const extra of restText) {
        await sdk.client.part.delete({
          sessionID: props.sessionID,
          messageID: props.messageID,
          partID: extra.id,
        })
      }

      const [firstThinking, ...restThinking] = thinkings
      if (firstThinking && newThinking !== firstThinking.text) {
        await sdk.client.part.update({
          sessionID: props.sessionID,
          messageID: props.messageID,
          partID: firstThinking.id,
          part: { ...firstThinking, text: newThinking },
        })
      }
      for (const extra of restThinking) {
        await sdk.client.part.delete({
          sessionID: props.sessionID,
          messageID: props.messageID,
          partID: extra.id,
        })
      }

      toast.show({ message: "Assistant message updated", variant: "success" })
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : "Failed to update message",
        variant: "error",
      })
    } finally {
      setBusy(false)
      dialog.clear()
    }
  }

  useBindings(() => ({
    enabled: !busy(),
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Save edited message",
        category: "Dialog",
        run: () => void save(),
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  useBindings(() => ({
    enabled: !busy() && props.hasText && props.hasThinking,
    priority: 1,
    bindings: [{ key: "tab", desc: "Switch field", group: "Dialog", cmd: switchField }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>Edit assistant message</b>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={props.hasText}>
        <box gap={1}>
          <text fg={theme.textMuted}>Message{props.hasThinking ? " (tab switches field)" : ""}</text>
          <textarea
            height={props.hasThinking ? 7 : 10}
            ref={(value: TextareaRenderable) => {
              textArea = value
            }}
            initialValue={props.text}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            cursorStyle={tuiConfig.cursor}
          />
        </box>
      </Show>
      <Show when={props.hasThinking}>
        <box gap={1}>
          <text fg={theme.textMuted}>Thinking{props.hasText ? " (tab switches field)" : ""}</text>
          <textarea
            height={5}
            ref={(value: TextareaRenderable) => {
              thinkingArea = value
            }}
            initialValue={props.thinking}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            cursorStyle={tuiConfig.cursor}
          />
        </box>
      </Show>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!busy()} fallback={<text fg={theme.textMuted}>processing…</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>save</span>
            </text>
          </Show>
        </Show>
      </box>
      <Show when={busy()}>
        <Spinner color={theme.textMuted}>Saving…</Spinner>
      </Show>
    </box>
  )
}

export function DialogEditAssistant(props: { sessionID: string }) {
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result: DialogSelectOption<string>[] = []
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const parts = sync.data.part[message.id] ?? []
      const texts = parts.filter((part): part is TextPart => part.type === "text" && !part.synthetic)
      const thinkings = parts.filter((part): part is ReasoningPart => part.type === "reasoning")
      if (texts.length === 0 && thinkings.length === 0) continue
      const preview = texts[0]?.text.replace(/\n/g, " ") || "Thinking…"
      result.push({
        title: preview.length > 80 ? `${preview.slice(0, 79)}…` : preview,
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (selectDialog) => {
          const current = sync.data.part[message.id] ?? []
          const currentTexts = current
            .filter((part): part is TextPart => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n\n")
          const currentThinking = current
            .filter((part): part is ReasoningPart => part.type === "reasoning")
            .map((part) => part.text)
            .join("\n\n")
          selectDialog.replace(() => (
            <Editor
              sessionID={props.sessionID}
              messageID={message.id}
              text={currentTexts}
              thinking={currentThinking}
              hasText={currentTexts.length > 0 || texts.length > 0}
              hasThinking={currentThinking.length > 0 || thinkings.length > 0}
            />
          ))
        },
      })
    }
    return [...result.reverse()]
  })

  return <DialogSelect title="Edit assistant message" options={options()} />
}

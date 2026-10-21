import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { TuiPluginApi } from "@sixfinger/plugin/tui"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { usePromptRef } from "../../context/prompt"
import { useBindings } from "../../keymap"
import { Spinner } from "../../component/spinner"

const RULE = "─".repeat(60)

export function SideQuestionCard(props: {
  sessionID: string
  question: string
  model: { providerID: string; modelID: string; variant?: string }
  onInsert: (text: string) => void
  onClose: () => void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const toast = useToast()
  const promptRef = usePromptRef()
  const [state, setState] = createSignal<"loading" | "done" | "error">("loading")
  const [response, setResponse] = createSignal("")
  const [error, setError] = createSignal("")
  const [inserted, setInserted] = createSignal(false)

  onMount(() => {
    void sdk.client.session
      .sideQuestion(
        {
          sessionID: props.sessionID,
          question: props.question,
          providerID: props.model.providerID,
          modelID: props.model.modelID,
        },
        { throwOnError: true },
      )
      .then((res) => {
        const text = res.data?.response
        if (!text) {
          setError("No response received")
          setState("error")
          return
        }
        setResponse(text)
        setState("done")
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Side question failed")
        setState("error")
      })
  })

  const quoted = createMemo(() => `> ${props.question.replace(/\n/g, "\n> ")}\n\n${response()}`)

  const copy = () => {
    if (state() !== "done") return
    void clipboard
      .write?.(response())
      .then(() => toast.show({ message: "Side question answer copied to clipboard", variant: "success" }))
      .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
  }

  const insert = () => {
    if (state() !== "done" || inserted()) return
    props.onInsert(quoted())
    setInserted(true)
    props.onClose()
  }

  useBindings(() => ({
    enabled: true,
    bindings: [
      { key: "escape", desc: "Close side question", group: "Side question", cmd: () => props.onClose() },
      ...(state() === "done" && !promptRef.current?.focused
        ? [
            { key: "c", desc: "Copy answer", group: "Side question", cmd: copy },
            { key: "i", desc: "Insert into prompt", group: "Side question", cmd: insert },
          ]
        : []),
    ],
  }))

  return (
    <box
      position="absolute"
      right={1}
      bottom={9}
      width={64}
      maxHeight={22}
      backgroundColor={theme.backgroundPanel}
      border={["top", "bottom", "left", "right"]}
      borderColor={theme.warning}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.warning}>
          <b>?</b>
        </text>
        <text fg={theme.text} wrapMode="word">
          {props.question}
        </text>
      </box>
      <text flexShrink={0} fg={theme.border}>
        {RULE}
      </text>
      <box flexGrow={1} overflow="hidden">
        <Show
          when={state() !== "loading"}
          fallback={
            <box flexDirection="row" gap={1}>
              <Spinner />
              <text fg={theme.textMuted}>Thinking...</text>
            </box>
          }
        >
          <Show
            when={state() === "done"}
            fallback={
              <text fg={theme.error} wrapMode="word">
                {error()}
              </text>
            }
          >
            <text fg={theme.text} wrapMode="word">
              {response()}
            </text>
          </Show>
        </Show>
      </box>
      <text flexShrink={0} fg={theme.border}>
        {RULE}
      </text>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <Show
          when={state() === "done"}
          fallback={<text fg={theme.textMuted}>esc to dismiss</text>}
        >
          <text fg={theme.textMuted}>
            <Show when={!inserted()} fallback={<text fg={theme.success}>Inserted to prompt</text>}>
              c copy · i insert to prompt · esc dismiss
            </Show>
          </text>
        </Show>
      </box>
    </box>
  )
}

export type SideQuestionApi = TuiPluginApi

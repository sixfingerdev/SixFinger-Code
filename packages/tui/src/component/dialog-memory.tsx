import { createMemo, createSignal, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"

type Memory = { id: string; scope: string; source: string; tags: string[]; content: string }

/**
 * Browse and delete stored memories (global + this session's scope).
 */
export function DialogMemory(props: { sessionID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const [items, setItems] = createSignal<Memory[]>([])
  const [ready, setReady] = createSignal(false)

  onMount(() => {
    void sdk.client.session
      .memories({ sessionID: props.sessionID, workspace: project.workspace.current() }, { throwOnError: true })
      .then((result: { data?: Memory[] }) => {
        setItems(result.data ?? [])
        setReady(true)
      })
  })

  const remove = (memoryID: string) => {
    void sdk.client.session.memory
      .remove(
        { sessionID: props.sessionID, memoryID, workspace: project.workspace.current() },
        { throwOnError: true },
      )
      .then(() => {
        setItems(items().filter((memory) => memory.id !== memoryID))
        toast.show({ message: "Memory deleted", variant: "success" })
      })
  }

  const options = createMemo(() =>
    items().map((memory) => ({
      value: memory.id,
      title: memory.content.slice(0, 90),
      description: `${memory.scope} · ${memory.source}`,
      onSelect: () => remove(memory.id),
    })),
  )

  return (
    <DialogSelect<string>
      title={ready() && items().length === 0 ? "No memories stored" : "Memories (select to delete)"}
      current={undefined}
      options={options()}
    />
  )
}

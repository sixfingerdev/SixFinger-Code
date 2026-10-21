import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@sixfinger/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~sixfinger/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~sixfinger/WorkspaceRef", {
  defaultValue: () => undefined,
})

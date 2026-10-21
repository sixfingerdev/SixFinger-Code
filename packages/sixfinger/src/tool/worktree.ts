import * as Tool from "./tool"
import DESCRIPTION from "./worktree.txt"
import { Worktree } from "@/worktree"
import { Effect, Schema } from "effect"

export const ListParameters = Schema.Struct({})

export const WorktreeListTool = Tool.define<typeof ListParameters, { output: string }, Worktree.Service>(
  "worktree_list",
  Effect.gen(function* () {
    const worktrees = yield* Worktree.Service
    return {
      description:
        "List git worktrees for the current project. Use this before worktree_enter to see existing worktrees and their branches.",
      parameters: ListParameters,
      execute: () =>
        Effect.gen(function* () {
          const items = yield* worktrees.list()
          if (items.length === 0) {
            const output = "No worktrees. Create one with worktree_create."
            return { title: "No worktrees", metadata: { output }, output }
          }
          const output = items
            .map((item) => `${item.name}  ${item.branch ? `(${item.branch}) ` : ""}${item.directory}`)
            .join("\n")
          return { title: `${items.length} worktree(s)`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const EnterParameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Name for the new worktree (also used for its branch). A new branch is created automatically.",
  }),
  start_command: Schema.optional(Schema.String).annotate({
    description: "Startup script to run after the project's start command once the worktree is created.",
  }),
})

export const WorktreeEnterTool = Tool.define<
  typeof EnterParameters,
  { output: string },
  Worktree.Service
>(
  "worktree_enter",
  Effect.gen(function* () {
    const worktrees = yield* Worktree.Service
    return {
      description:
        "Create a fresh git worktree with a new branch for isolated work (parallel feature work, risky experiments). Returns the new directory; run subsequent commands there via the shell tool's workdir parameter.",
      parameters: EnterParameters,
      execute: (params: Schema.Schema.Type<typeof EnterParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "worktree",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })
          const info = yield* worktrees.create({
            name: params.name,
            ...(params.start_command ? { startCommand: params.start_command } : {}),
          })
          const output = [
            `Created worktree "${info.name}" on branch ${info.branch ?? "(detached)"} at ${info.directory}.`,
            `Run commands there with the shell tool's workdir parameter set to ${info.directory}.`,
          ].join(" ")
          return { title: `Worktree ${info.name}`, metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ExitParameters = Schema.Struct({
  directory: Schema.String.annotate({ description: "Worktree directory, as returned by worktree_enter or worktree_list." }),
})

export const WorktreeExitTool = Tool.define<
  typeof ExitParameters,
  { output: string },
  Worktree.Service
>(
  "worktree_exit",
  Effect.gen(function* () {
    const worktrees = yield* Worktree.Service
    return {
      description:
        "Remove a git worktree created with worktree_enter, deleting its branch. Uncommitted changes in that worktree are lost.",
      parameters: ExitParameters,
      execute: (params: Schema.Schema.Type<typeof ExitParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "worktree",
            patterns: [params.directory],
            always: [params.directory],
            metadata: {},
          })
          const ok = yield* worktrees.remove({ directory: params.directory })
          const output = ok ? `Removed worktree ${params.directory}.` : `Worktree ${params.directory} was not removed.`
          return { title: "Worktree removed", metadata: { output }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

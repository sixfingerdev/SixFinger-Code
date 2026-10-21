import path from "path"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import * as Tool from "./tool"
import DESCRIPTION from "./notebook-edit.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@sixfinger/core/fs-util"
import * as Bom from "@/util/bom"

/**
 * Minimal ipynb editor. Reads the notebook JSON, applies a cell-level
 * replacement, and writes it back. Only the fields the model edits are
 * rewritten; everything else in the JSON document is preserved verbatim.
 */

type Cell = {
  cell_type?: unknown
  source?: unknown
  outputs?: unknown
  execution_count?: unknown
}

const asLines = (value: unknown): string[] => {
  if (typeof value === "string") return value.split("\n")
  if (Array.isArray(value)) return value.map((line) => (typeof line === "string" ? line : String(line)))
  return []
}

export const Parameters = Schema.Struct({
  notebook_path: Schema.String.annotate({ description: "The absolute path to the .ipynb file to edit" }),
  cell_id: Schema.optional(Schema.String).annotate({
    description: "The id of the cell to edit. Preferred over new_source matching when present.",
  }),
  old_string: Schema.optional(Schema.String).annotate({
    description: "The exact cell source to replace. Must match the full current source of exactly one cell.",
  }),
  new_string: Schema.String.annotate({ description: "The new source for the cell" }),
})

const findCell = (cells: Cell[], params: Schema.Schema.Type<typeof Parameters>) => {
  if (params.cell_id) {
    const byId = cells.findIndex((cell) => (cell as { id?: unknown }).id === params.cell_id)
    if (byId >= 0) return byId
    // Stale id: fall through to old_string matching instead of failing hard.
  }
  if (params.old_string === undefined) return -1
  const target = asLines(params.old_string)
  const matches: number[] = []
  for (const [index, cell] of cells.entries()) {
    const source = asLines(cell.source)
    if (source.length === target.length && source.every((line, i) => line === target[i])) {
      matches.push(index)
    }
  }
  return matches.length === 1 ? matches[0]! : -matches.length - 1
}

const toSource = (value: string): string[] => {
  const lines = value.split("\n")
  return lines.map((line, index) => (index < lines.length - 1 ? line + "\n" : line))
}

export const NotebookEditTool = Tool.define(
  "notebook_edit",
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.notebook_path)
            ? params.notebook_path
            : path.join(instance.directory, params.notebook_path)
          if (!filePath.endsWith(".ipynb")) throw new Error(`Not a notebook file: ${filePath}`)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          const raw = yield* afs.readFileStringSafe(filePath).pipe(Effect.orDie)
          if (!raw) throw new Error(`File ${filePath} not found`)
          let document: { cells?: Cell[] }
          try {
            document = JSON.parse(raw)
          } catch {
            throw new Error(`Invalid JSON in notebook: ${filePath}`)
          }
          const cells = Array.isArray(document.cells) ? (document.cells as Cell[]) : []
          const found = findCell(cells, params)
          if (found < 0) {
            const ambiguous = found === -1 ? 0 : -found - 1
            throw new Error(
              params.cell_id && ambiguous === 0
                ? `Cell with id "${params.cell_id}" not found in ${filePath}`
                : `old_string must match the full source of exactly one cell (matched ${ambiguous}). Include the complete cell source and try again.`,
            )
          }
          const cell = cells[found]!
          const kind = typeof cell.cell_type === "string" ? cell.cell_type : "unknown"
          if (kind === "code" && params.new_string.includes("```")) {
            throw new Error("new_string must not contain triple backticks in code cells")
          }

          const diffBefore = asLines(cell.source).join("\n")
          cell.source = toSource(params.new_string)
          if (kind === "code") {
            cell.outputs = []
            cell.execution_count = null
          }

          const diffAfter = asLines(cell.source).join("\n")
          const changed = diffBefore !== diffAfter
          if (!changed) throw new Error("No changes to apply: new_string is identical to the current cell source.")

          const source = yield* Bom.readFile(afs, filePath)
          const desiredBom = source.bom
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filePath)],
            always: ["*"],
            metadata: {
              filepath: filePath,
              cell_type: kind,
              cell_index: found,
              diff: createTwoFilesPatch(
                path.basename(filePath),
                path.basename(filePath),
                diffBefore,
                diffAfter,
                `${kind} cell (before)`,
                `${kind} cell (after)`,
              ),
            },
          })
          yield* afs.writeWithDirs(filePath, Bom.join(JSON.stringify(document, null, 1) + "\n", desiredBom))

          const output = `Edited ${kind} cell ${found} in ${path.basename(filePath)}${kind === "code" ? " (outputs cleared)" : ""}.`
          return { title: `Notebook cell edited`, metadata: { output, cell_type: kind, cell_index: found }, output }
        }).pipe(Effect.orDie),
    }
  }),
)

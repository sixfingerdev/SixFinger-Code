import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_REVIEWER from "./prompt/reviewer.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_PLANNER from "./prompt/planner.txt"
import PROMPT_ARCHITECT from "./prompt/architect.txt"
import PROMPT_WRITER from "./prompt/writer.txt"
import PROMPT_TESTER from "./prompt/tester.txt"
import PROMPT_TEST_WRITER from "./prompt/test-writer.txt"
import PROMPT_DEBUGGER from "./prompt/debugger.txt"
import PROMPT_REFACTORER from "./prompt/refactorer.txt"
import PROMPT_CLEANER from "./prompt/cleaner.txt"
import PROMPT_SECURITY_AUDITOR from "./prompt/security-auditor.txt"
import PROMPT_PERF_OPTIMIZER from "./prompt/perf-optimizer.txt"
import PROMPT_MIGRATOR from "./prompt/migrator.txt"
import PROMPT_DEVOPS from "./prompt/devops.txt"
import PROMPT_TEAM_LEAD from "./prompt/team-lead.txt"
import PROMPT_CODER from "./prompt/coder.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          coder: {
            name: "coder",
            description: `Senior implementer. Turns well-defined tasks and plans into working, tested code with full tool access. Use this to execute implementation work, especially as a teammate.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_CODER,
            mode: "subagent",
            native: true,
          },
          reviewer: {
            name: "reviewer",
            description: `Code reviewer. Finds correctness bugs and security issues, verifies suspicions by running tests, and reports severity-ranked findings with a merge verdict. Never modifies code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_REVIEWER,
            mode: "subagent",
            native: true,
          },
          researcher: {
            name: "researcher",
            description: `Deep researcher. Investigates questions across the codebase and the web and reports with cited evidence, separated facts, inferences, and open questions. Never modifies anything.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_RESEARCHER,
            mode: "subagent",
            native: true,
          },
          planner: {
            name: "planner",
            description: `Implementation planner. Explores the codebase and writes a precise step-by-step plan another agent can execute. Writes plan files only, never source code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_PLANNER,
            mode: "subagent",
            native: true,
          },
          architect: {
            name: "architect",
            description: `Software architect. Designs systems and records decisions in design documents. Studies the existing architecture first and never implements.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_ARCHITECT,
            mode: "subagent",
            native: true,
          },
          writer: {
            name: "writer",
            description: `Technical writer. Writes and maintains documentation: guides, how-tos, and references. Edits markdown docs only, never source code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
                edit: {
                  "*": "deny",
                  "*.md": "allow",
                  "*.mdx": "allow",
                },
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_WRITER,
            mode: "subagent",
            native: true,
          },
          tester: {
            name: "tester",
            description: `Testing engineer. Runs test suites, diagnoses failures, and fixes root causes with minimal covered changes. Reports results with counts.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_TESTER,
            mode: "subagent",
            native: true,
          },
          "test-writer": {
            name: "test-writer",
            description: `Test author. Expands test coverage for code that lacks it, testing real behavior through public interfaces. Never changes production code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_TEST_WRITER,
            mode: "subagent",
            native: true,
          },
          debugger: {
            name: "debugger",
            description: `Debugging specialist. Reproduces failures, isolates root causes with evidence, and applies minimal proven fixes with regression tests.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_DEBUGGER,
            mode: "subagent",
            native: true,
          },
          refactorer: {
            name: "refactorer",
            description: `Refactoring specialist. Restructures code without changing behavior, in small test-verified steps. Reports before/after test results.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_REFACTORER,
            mode: "subagent",
            native: true,
          },
          cleaner: {
            name: "cleaner",
            description: `Code cleaner. Removes dead code, unused dependencies, and stale comments in small verified batches, proving disuse before deleting.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_CLEANER,
            mode: "subagent",
            native: true,
          },
          "security-auditor": {
            name: "security-auditor",
            description: `Security auditor. Finds vulnerabilities with attack scenarios, severity ratings, and concrete remediation. Report only, never modifies code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_SECURITY_AUDITOR,
            mode: "subagent",
            native: true,
          },
          "perf-optimizer": {
            name: "perf-optimizer",
            description: `Performance engineer. Profiles first, optimizes the measured hot path, and proves every change with before/after benchmarks.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_PERF_OPTIMIZER,
            mode: "subagent",
            native: true,
          },
          migrator: {
            name: "migrator",
            description: `Migration specialist. Upgrades dependencies and frameworks incrementally with codemods, per-step verification, and rollback notes.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_MIGRATOR,
            mode: "subagent",
            native: true,
          },
          devops: {
            name: "devops",
            description: `DevOps engineer. Builds and fixes CI workflows, containers, and delivery scripts. Never writes application feature code.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_DEVOPS,
            mode: "subagent",
            native: true,
          },
          "team-lead": {
            name: "team-lead",
            description: `Team coordinator. Decomposes missions, spawns and guides teammates via the task tool, tracks work in task files, and integrates results. Delegates all implementation.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                webfetch: "allow",
                websearch: "allow",
                question: "allow",
                task: "allow",
                send_message: "allow",
                task_create: "allow",
                task_update: "allow",
                task_list: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            prompt: PROMPT_TEAM_LEAD,
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"

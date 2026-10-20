/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeSixfingerContent from "./skill/customize-sixfinger.md" with { type: "text" }

export const CustomizeSixfingerContent = customizeSixfingerContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-sixfinger",
            description:
              "Use ONLY when the user is editing or creating sixfinger's own configuration: sixfinger.json, sixfinger.jsonc, files under .sixfinger/, or files under ~/.config/sixfinger/. Also use when creating or fixing sixfinger agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring sixfinger itself.",
            location: AbsolutePath.make("/builtin/customize-sixfinger.md"),
            content: CustomizeSixfingerContent,
          }),
        }),
      )
    })
  }),
})

import { Config } from "@/config/config"
import { CompactionSetting } from "@/session/compaction-setting"
import { ConfigV1 } from "@sixfinger/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const CompactionWindowPayload = Schema.Struct({
  window: CompactionSetting.schema,
})

export const CompactionWindowResponse = Schema.Struct({
  window: CompactionSetting.schema,
})

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current SixFinger configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update SixFinger configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("compaction", `${root}/compaction`, {
          query: WorkspaceRoutingQuery,
          success: described(CompactionWindowResponse, "Auto-compact window setting"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.compaction.get",
            summary: "Get auto-compact window",
            description: "Get the current auto-compact window setting (auto-low, auto-medium, auto-max, or a token count).",
          }),
        ),
        HttpApiEndpoint.post("compactionSet", `${root}/compaction`, {
          query: WorkspaceRoutingQuery,
          payload: CompactionWindowPayload,
          success: described(CompactionWindowResponse, "Auto-compact window setting"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.compaction.set",
            summary: "Set auto-compact window",
            description:
              "Set the auto-compact window: auto-low, auto-medium, auto-max (recommended), or an explicit token count capped to the model context.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "sixfinger experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

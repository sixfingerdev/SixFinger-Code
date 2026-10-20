import { AgentV2 } from "@sixfinger/core/agent"
import { AISDK } from "@sixfinger/core/aisdk"
import { Catalog } from "@sixfinger/core/catalog"
import { CommandV2 } from "@sixfinger/core/command"
import { Credential } from "@sixfinger/core/credential"
import { AppNodeBuilder } from "@sixfinger/core/effect/app-node-builder"
import { LayerNodePlatform } from "@sixfinger/core/effect/app-node-platform"
import { LayerNode } from "@sixfinger/core/effect/layer-node"
import { EventV2 } from "@sixfinger/core/event"
import { FileSystem } from "@sixfinger/core/filesystem"
import { FSUtil } from "@sixfinger/core/fs-util"
import { Integration } from "@sixfinger/core/integration"
import { Location } from "@sixfinger/core/location"
import { Npm } from "@sixfinger/core/npm"
import { PluginV2 } from "@sixfinger/core/plugin"
import { Reference } from "@sixfinger/core/reference"
import { SkillV2 } from "@sixfinger/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)

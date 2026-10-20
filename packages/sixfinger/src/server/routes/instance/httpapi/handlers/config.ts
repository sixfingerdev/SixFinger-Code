import { Config } from "@/config/config"
import { CompactionSetting } from "@/session/compaction-setting"
import { CompactionWindowPayload } from "../groups/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    CompactionSetting.load()

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const compactionGet = Effect.fn("ConfigHttpApi.compactionGet")(function* () {
      return { window: CompactionSetting.get() }
    })

    const compactionSet = Effect.fn("ConfigHttpApi.compactionSet")(function* (ctx: {
      payload: typeof CompactionWindowPayload.Type
    }) {
      const window = yield* CompactionSetting.set(ctx.payload.window).pipe(
        Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return { window }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("compaction", compactionGet)
      .handle("compactionSet", compactionSet)
  }),
)

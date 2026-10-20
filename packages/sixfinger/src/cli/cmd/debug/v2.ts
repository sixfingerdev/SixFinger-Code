import { EOL } from "os"
import { Effect } from "effect"
import { Catalog } from "@sixfinger/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@sixfinger/core/location-services"
import { Location } from "@sixfinger/core/location"
import { AbsolutePath } from "@sixfinger/core/schema"
import { effectCmd } from "../../effect-cmd"

export const V2Command = effectCmd({
  command: "v2",
  describe: "debug v2 catalog and built-in plugins",
  instance: false,
  handler: () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providers = (yield* catalog.provider.available()).sort((a, b) => a.id.localeCompare(b.id))
      const all = (yield* catalog.provider.all()).sort((a, b) => a.id.localeCompare(b.id))
      const result = {
        providers,
        default: catalog.model.default().pipe(Effect.map((item) => item?.id)),
        small: Object.fromEntries(
          yield* Effect.all(
            all.map((provider) =>
              Effect.map(catalog.model.small(provider.id), (model) => [provider.id, model?.id] as const),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      }
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.v2"),
      Effect.provide(
        LocationServiceMap.Service.get(
          Location.Ref.make({
            directory: AbsolutePath.make(process.cwd()),
          }),
        ),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})

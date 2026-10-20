import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.SIXFINGER_CHANNEL ?? "dev"}`

await $`cd ../sixfinger && bun script/build-node.ts`
await downloadCliToResources()

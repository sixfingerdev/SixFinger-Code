export * from "./client.js"
export * from "./server.js"

import { createSixfingerClient } from "./client.js"
import { createSixfingerServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createSixfinger(options?: ServerOptions) {
  const server = await createSixfingerServer({
    ...options,
  })

  const client = createSixfingerClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

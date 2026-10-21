interface ImportMetaEnv {
  readonly SIXFINGER_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:sixfinger-server" {
  export namespace Server {
    export const listen: typeof import("../../../sixfinger/dist/types/src/node").Server.listen
    export type Listener = import("../../../sixfinger/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../sixfinger/dist/types/src/node").Config.get
    export type Info = import("../../../sixfinger/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../sixfinger/dist/types/src/node").bootstrap
}

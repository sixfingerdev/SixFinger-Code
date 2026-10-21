import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["SIXFINGER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["SIXFINGER_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("SIXFINGER_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  SIXFINGER_AUTO_HEAP_SNAPSHOT: truthy("SIXFINGER_AUTO_HEAP_SNAPSHOT"),
  SIXFINGER_GIT_BASH_PATH: process.env["SIXFINGER_GIT_BASH_PATH"],
  SIXFINGER_CONFIG: process.env["SIXFINGER_CONFIG"],
  SIXFINGER_CONFIG_CONTENT: process.env["SIXFINGER_CONFIG_CONTENT"],
  SIXFINGER_DISABLE_AUTOUPDATE: truthy("SIXFINGER_DISABLE_AUTOUPDATE"),
  SIXFINGER_ALWAYS_NOTIFY_UPDATE: truthy("SIXFINGER_ALWAYS_NOTIFY_UPDATE"),
  SIXFINGER_DISABLE_PRUNE: truthy("SIXFINGER_DISABLE_PRUNE"),
  SIXFINGER_DISABLE_TERMINAL_TITLE: truthy("SIXFINGER_DISABLE_TERMINAL_TITLE"),
  SIXFINGER_SHOW_TTFD: truthy("SIXFINGER_SHOW_TTFD"),
  SIXFINGER_DISABLE_AUTOCOMPACT: truthy("SIXFINGER_DISABLE_AUTOCOMPACT"),
  SIXFINGER_DISABLE_MODELS_FETCH: truthy("SIXFINGER_DISABLE_MODELS_FETCH"),
  SIXFINGER_DISABLE_MOUSE: truthy("SIXFINGER_DISABLE_MOUSE"),
  SIXFINGER_FAKE_VCS: process.env["SIXFINGER_FAKE_VCS"],
  SIXFINGER_SERVER_PASSWORD: process.env["SIXFINGER_SERVER_PASSWORD"],
  SIXFINGER_SERVER_USERNAME: process.env["SIXFINGER_SERVER_USERNAME"],
  SIXFINGER_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("SIXFINGER_DISABLE_FFF"),

  // Experimental
  SIXFINGER_EXPERIMENTAL_FILEWATCHER: Config.boolean("SIXFINGER_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  SIXFINGER_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("SIXFINGER_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  SIXFINGER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("SIXFINGER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  SIXFINGER_MODELS_URL: process.env["SIXFINGER_MODELS_URL"],
  SIXFINGER_MODELS_PATH: process.env["SIXFINGER_MODELS_PATH"],
  SIXFINGER_DB: process.env["SIXFINGER_DB"],

  SIXFINGER_WORKSPACE_ID: process.env["SIXFINGER_WORKSPACE_ID"],
  SIXFINGER_EXPERIMENTAL_WORKSPACES: enabledByExperimental("SIXFINGER_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get SIXFINGER_DISABLE_PROJECT_CONFIG() {
    return truthy("SIXFINGER_DISABLE_PROJECT_CONFIG")
  },
  get SIXFINGER_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("SIXFINGER_EXPERIMENTAL_REFERENCES")
  },
  get SIXFINGER_TUI_CONFIG() {
    return process.env["SIXFINGER_TUI_CONFIG"]
  },
  get SIXFINGER_CONFIG_DIR() {
    return process.env["SIXFINGER_CONFIG_DIR"]
  },
  get SIXFINGER_PURE() {
    return truthy("SIXFINGER_PURE")
  },
  get SIXFINGER_PERMISSION() {
    return process.env["SIXFINGER_PERMISSION"]
  },
  get SIXFINGER_PLUGIN_META_FILE() {
    return process.env["SIXFINGER_PLUGIN_META_FILE"]
  },
  get SIXFINGER_CLIENT() {
    return process.env["SIXFINGER_CLIENT"] ?? "cli"
  },
}

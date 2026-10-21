import path from "path"

process.env.SIXFINGER_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.SIXFINGER_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.SIXFINGER_DISABLE_MODELS_FETCH = "true"

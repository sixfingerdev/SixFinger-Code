import { randomBytes } from "crypto"
import { spawn } from "child_process"
import { cmd } from "./cmd"
import * as Login from "../../sixfinger/login"
import { createBridge, httpLocal } from "../../sixfinger/link"

const say = (m: string) => process.stderr.write(m + "\n")

/** Kendi (yerel) sunucusunu başlatır: parola rastgele, yalnızca 127.0.0.1. */
async function startLocalServer(password: string): Promise<{ url: string; stop: () => void }> {
  const compiled = import.meta.path.startsWith("/$bunfs") || import.meta.path.includes("$bunfs")
  const argv = compiled ? ["serve", "--hostname", "127.0.0.1", "--port", "0"] : [process.argv[1]!, "serve", "--hostname", "127.0.0.1", "--port", "0"]
  const child = spawn(process.execPath, argv, { env: { ...process.env, SIXFINGER_SERVER_PASSWORD: password }, stdio: ["ignore", "pipe", "inherit"] })
  const url = await new Promise<string>((resolve, reject) => {
    let buf = ""
    const timer = setTimeout(() => reject(new Error("local server did not start")), 30_000)
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString()
      const m = /listening on (http:\/\/\S+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        resolve(m[1]!)
      }
    })
    child.on("exit", (code) => reject(new Error(`local server exited (${code})`)))
  })
  return { url, stop: () => child.kill() }
}

export const LinkCommand = cmd({
  command: "link",
  describe: Login.lang() === "tr" ? "bu cihazdaki oturumları site ve uygulamadan izlenebilir yap" : "make this device's sessions viewable and controllable from the website and app",
  builder: (yargs) =>
    yargs
      .option("url", { type: "string", describe: Login.lang() === "tr" ? "çalışan yerel sunucu (verilmezse kendisi başlatır)" : "running local server (started automatically if omitted)" })
      .option("password", { type: "string", describe: "SIXFINGER_SERVER_PASSWORD" }),
  handler: async (args) => {
    const tr = Login.lang() === "tr"
    const ac = new AbortController()
    let stop = () => {}
    process.on("SIGINT", () => ac.abort())
    process.on("SIGTERM", () => ac.abort())
    try {
      let base = args.url
      let password = args.password ?? process.env.SIXFINGER_SERVER_PASSWORD
      if (!base) {
        password = randomBytes(18).toString("base64url")
        const s = await startLocalServer(password)
        base = s.url
        stop = s.stop
      }
      const bridge = createBridge(httpLocal(base, password), { server: Login.server(), token: (force) => Login.accessToken(force) }, { log: (m) => say(`[link] ${m}`) })
      say(tr ? `Köprü açık: oturumlar ${Login.server()} üzerinden izlenebilir. Durdurmak için Ctrl+C.` : `Bridge is on: sessions are viewable at ${Login.server()}. Press Ctrl+C to stop.`)
      await bridge.loop(ac.signal)
    } catch (e) {
      say(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
    } finally {
      stop()
    }
  },
})

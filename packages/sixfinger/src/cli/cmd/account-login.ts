import { cmd } from "./cmd"
import * as Login from "../../sixfinger/login"

export const LoginCommand = cmd({
  command: "login",
  describe: "SixFinger hesabına giriş yap (tarayıcıda onaylanır)",
  handler: async () => {
    const s = await Login.read()
    if (s) {
      process.stderr.write(`Zaten giriş yapılmış${s.user.email ? `: ${s.user.email}` : ""}. Çıkmak için: sixfinger logout\n`)
      return
    }
    await Login.deviceLogin().catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exitCode = 1
    })
  },
})

export const LogoutCommand = cmd({
  command: "logout",
  describe: "SixFinger hesabından çık (bu cihazdaki jetonu siler)",
  handler: async () => {
    const s = await Login.read()
    if (s) {
      // Sunucudaki oturumu da kapat; ağ yoksa yerel silme yeter.
      await fetch(`${Login.server()}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: s.refresh }),
      }).catch(() => {})
    }
    await Login.clear()
    process.stderr.write("Çıkış yapıldı.\n")
  },
})

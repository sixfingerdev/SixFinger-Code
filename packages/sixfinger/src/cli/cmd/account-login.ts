import { cmd } from "./cmd"
import * as Login from "../../sixfinger/login"

export const LoginCommand = cmd({
  command: "login",
  describe: Login.lang() === "tr" ? "SixFinger hesabına giriş yap (tarayıcıda onaylanır)" : "sign in to your SixFinger account (approved in the browser)",
  handler: async () => {
    const s = await Login.read()
    if (s) {
      process.stderr.write((Login.lang() === "tr" ? `Zaten giriş yapılmış${s.user.email ? `: ${s.user.email}` : ""}. Çıkmak için: sixfinger logout` : `Already signed in${s.user.email ? `: ${s.user.email}` : ""}. To sign out: sixfinger logout`) + "\n")
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
  describe: Login.lang() === "tr" ? "SixFinger hesabından çık (bu cihazdaki jetonu siler)" : "sign out of SixFinger (removes the token on this device)",
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
    process.stderr.write((Login.lang() === "tr" ? "Çıkış yapıldı." : "Signed out.") + "\n")
  },
})

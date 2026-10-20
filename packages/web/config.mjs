const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://code.sixfinger.live" : `https://${stage}.code.sixfinger.live`,
  console: stage === "production" ? "https://code.sixfinger.live/auth" : `https://${stage}.code.sixfinger.live/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/sixfingerdev/sixfinger-code",
  discord: "https://code.sixfinger.live/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}

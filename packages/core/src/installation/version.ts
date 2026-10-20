declare global {
  const SIXFINGER_VERSION: string
  const SIXFINGER_CHANNEL: string
}

export const InstallationVersion = typeof SIXFINGER_VERSION === "string" ? SIXFINGER_VERSION : "local"
export const InstallationChannel = typeof SIXFINGER_CHANNEL === "string" ? SIXFINGER_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

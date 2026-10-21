import { afterAll, beforeAll, describe, expect, test } from "bun:test"

describe("sunucu sistem istemi", () => {
  let srv: ReturnType<typeof Bun.serve>
  const TEXT = "You are SixFinger Code. ".padEnd(120, "x")
  beforeAll(() => {
    srv = Bun.serve({ port: 0, fetch: () => Response.json({ version: 3, text: TEXT }) })
    process.env.XDG_CACHE_HOME = `/tmp/sf-prompt-test-${Date.now()}`
  })
  afterAll(() => {
    void srv.stop()
  })

  test("sunucudan alır, önbelleğe yazar; sunucu kapalıyken önbellekten yükler; yoksa asgari metin", async () => {
    process.env.SIXFINGER_SERVER = `http://localhost:${srv.port}`
    const P = await import("../../src/sixfinger/prompt")
    expect(P.get()).toContain("SixFinger Code") // asgari metin
    await P.refresh()
    expect(P.get()).toBe(TEXT)
    // yeni "süreç": modülü sıfırla, sunucuyu kapat → önbellek
    process.env.SIXFINGER_SERVER = "http://localhost:1"
    // @ts-expect-error sorgu dizesiyle modülü yeniden yüklemek için
    const P2 = await import("../../src/sixfinger/prompt?fresh=1")
    await P2.refresh(500)
    expect(P2.get()).toBe(TEXT)
  })
})

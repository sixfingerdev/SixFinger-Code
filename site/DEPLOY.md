# code.sixfinger.live: siteyi sunucuya yükleme

`site/` klasörü tamamen statiktir: `index.html` (tanıtım sayfası), `install` (kurulum betiği), `Caddyfile`.

## 1. Pi'ye (ya da herhangi bir sunucuya) koy
```bash
sudo mkdir -p /srv/sixfinger-code-site
git clone --depth 1 https://github.com/sixfingerdev/SixFinger-Code /tmp/sf && sudo cp -r /tmp/sf/site/* /srv/sixfinger-code-site/
```
Güncellemek için aynı iki komutu tekrar çalıştır (ya da `git pull` + `cp`).

## 2. Sun
**Caddy (önerilen, HTTPS otomatik):** `site/Caddyfile` içindeki alan adı zaten `code.sixfinger.live`. DNS'te `code` için A/AAAA kaydı sunucuya baksın, sonra `sudo caddy run --config /srv/sixfinger-code-site/Caddyfile` (ya da mevcut Caddy yapılandırmana ekle).

**nginx:** 
```nginx
server {
  server_name code.sixfinger.live;
  root /srv/sixfinger-code-site;
  location = /install { default_type text/x-shellscript; add_header Cache-Control no-cache; }
}
```
(TLS için certbot.) **Cloudflare Tunnel** kullanıyorsan tünelin hedefini bu statik sunucuya yönlendir.

## 3. Doğrula
```bash
curl -fsSL https://code.sixfinger.live/install | head -3   # betiğin ilk satırları gelmeli
```

## 4. Kurulumun çalışması için gerekli: sürüm dosyaları
`install` betiği şu adresten indirir:
`https://github.com/sixfingerdev/SixFinger-Code/releases/latest/download/sixfinger-<os>-<arch>.tar.gz`
(`os`: `linux`/`darwin`, `arch`: `x64`/`arm64`). Arşivin içinde `sixfinger` adlı çalıştırılabilir dosya olmalı.
Derleme: `cd packages/sixfinger && SIXFINGER_VERSION=… bun run build --single` → `dist/sixfinger-<os>-<arch>/bin/sixfinger`; dosyayı `tar -czf sixfinger-<os>-<arch>.tar.gz sixfinger` ile paketleyip GitHub Release'e yükle.
**Otomasyon:** `.github/workflows/release-cli.yml` `v*` etiketinde (ya da Actions'tan elle, sürüm girerek) 4 hedef için derleyip dosyaları Release'e yükler. İlk sürüm: `git tag v0.1.0 && git push origin v0.1.0`. Release yokken `install` "indirilemedi" der. Not: derleme web arayüzünü de gömer (`packages/app`), bu yüzden CI'ın `ghostty-web` bağımlılığını indirebilmesi gerekir (bu sandbox'ta 403 veriyordu, GitHub Actions'ta sorun olmamalı).

## Notlar
- Sayfa MIT atfını (opencode) altbilgide taşır; lisans gereği kaldırma.
- `code.sixfinger.live/config.json` (yapılandırma `$schema` adresi) henüz yok; istenirse çatalın şemasından üretilip bu klasöre konabilir.

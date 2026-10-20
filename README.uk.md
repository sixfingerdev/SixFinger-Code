<p align="center">
  <a href="https://code.sixfinger.live">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="SixFinger logo">
    </picture>
  </a>
</p>
<p align="center">AI-агент для програмування з відкритим кодом.</p>
<p align="center">
  <a href="https://code.sixfinger.live/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/sixfinger-code"><img alt="npm" src="https://img.shields.io/npm/v/sixfinger-code?style=flat-square" /></a>
  <a href="https://github.com/sixfingerdev/sixfinger-code/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sixfingerdev/sixfinger-code/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![SixFinger Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://code.sixfinger.live)

---

### Встановлення

```bash
# YOLO
curl -fsSL https://code.sixfinger.live/install | bash

# Менеджери пакетів
npm i -g sixfinger-code@latest        # або bun/pnpm/yarn
scoop install sixfinger             # Windows
choco install sixfinger             # Windows
brew install sixfingerdev/tap/sixfinger # macOS і Linux (рекомендовано, завжди актуально)
brew install sixfinger              # macOS і Linux (офіційна формула Homebrew, оновлюється рідше)
sudo pacman -S sixfinger            # Arch Linux (Stable)
paru -S sixfinger-bin               # Arch Linux (Latest from AUR)
mise use -g sixfinger               # Будь-яка ОС
nix run nixpkgs#sixfinger           # або github:sixfingerdev/sixfinger-code для найновішої dev-гілки
```

> [!TIP]
> Перед встановленням видаліть версії старші за 0.1.x.

### Десктопний застосунок (BETA)

SixFinger також доступний як десктопний застосунок. Завантажуйте напряму зі [сторінки релізів](https://github.com/sixfingerdev/sixfinger-code/releases) або [code.sixfinger.live/download](https://code.sixfinger.live/download).

| Платформа             | Завантаження                       |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `sixfinger-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `sixfinger-desktop-mac-x64.dmg`     |
| Windows               | `sixfinger-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` або AppImage        |

```bash
# macOS (Homebrew)
brew install --cask sixfinger-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/sixfinger-desktop
```

#### Каталог встановлення

Скрипт встановлення дотримується такого порядку пріоритету для шляху встановлення:

1. `$SIXFINGER_INSTALL_DIR` - Користувацький каталог встановлення
2. `$XDG_BIN_DIR` - Шлях, сумісний зі специфікацією XDG Base Directory
3. `$HOME/bin` - Стандартний каталог користувацьких бінарників (якщо існує або його можна створити)
4. `$HOME/.sixfinger/bin` - Резервний варіант за замовчуванням

```bash
# Приклади
SIXFINGER_INSTALL_DIR=/usr/local/bin curl -fsSL https://code.sixfinger.live/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://code.sixfinger.live/install | bash
```

### Агенти

SixFinger містить два вбудовані агенти, між якими можна перемикатися клавішею `Tab`.

- **build** - Агент за замовчуванням із повним доступом для завдань розробки
- **plan** - Агент лише для читання для аналізу та дослідження коду
  - За замовчуванням забороняє редагування файлів
  - Запитує дозвіл перед запуском bash-команд
  - Ідеально підходить для дослідження незнайомих кодових баз або планування змін

Також доступний допоміжний агент **general** для складного пошуку та багатокрокових завдань.
Він використовується всередині системи й може бути викликаний у повідомленнях через `@general`.

Дізнайтеся більше про [agents](https://code.sixfinger.live/docs/agents).

### Документація

Щоб дізнатися більше про налаштування SixFinger, [**перейдіть до нашої документації**](https://code.sixfinger.live/docs).

### Внесок

Якщо ви хочете зробити внесок в SixFinger, будь ласка, прочитайте нашу [документацію для контриб'юторів](./CONTRIBUTING.md) перед надсиланням pull request.

### Проєкти на базі SixFinger

Якщо ви працюєте над проєктом, пов'язаним з SixFinger, і використовуєте "sixfinger" у назві, наприклад "sixfinger-dashboard" або "sixfinger-mobile", додайте примітку до свого README.
Уточніть, що цей проєкт не створений командою SixFinger і жодним чином не афілійований із нами.

---

**Приєднуйтеся до нашої спільноти** [Discord](https://discord.gg/sixfinger) | [X.com](https://x.com/sixfinger)

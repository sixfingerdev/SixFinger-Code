# SixFinger Code

A fork of [sixfinger](https://github.com/sixfingerdev/sixfinger-code) with a set of custom features and a
developer-focused workflow.

This repository keeps the full upstream history, so upstream changes can be pulled in with
`git fetch upstream` + `git rebase upstream/dev`.

## What's in the fork

### Scheduling and automation

- **Cron** — scheduled prompts that wake a session on an interval or a one-shot time.
  - Runtime: `src/session/cron-scheduler.ts` (pure functions, dynamically imported at bootstrap to
    avoid the `InstanceBootstrap` → `InstanceStore.node` layer cycle).
  - Tool: `src/tool/cron.ts` (create / list / remove jobs).
  - HTTP API: `groups/experimental.ts` (`/cron` endpoints), surfaced in the TUI as `/cron`.
- **Background jobs** — `BackgroundJob.start` powers the cron scheduler and long-running work.
- **Wakeup and sleep** — `src/tool/wakeup.ts`, `src/tool/sleep.ts` for deferred continuations.
- **Monitor** — `src/tool/monitor.ts` watches commands, files, and webhooks in the background.

### Memory and recall

- **Memory store** — `src/session/memory-store.ts` + `src/session/memory-extract.ts`, exposed via the
  `memory` tool and a `/memory` TUI dialog. Memories persist across sessions.
- **Session search** — `src/tool/session-search.ts` does full-text search over the session database.
- **Tool search** — `src/tool/tool-search.ts` resolves tool definitions on demand instead of shipping
  every schema in every request. Registered as a resolved `Def` via `Effect.cached(Tool.init(...))`.

### Multi-agent workflows

- **Team** — `src/team/` with a `team-lead` orchestrator and teammate roles; `src/tool/team.ts`
  creates and coordinates teammates.
- **Mixture of agents** — `src/tool/moa.ts` runs several agents in parallel and aggregates their
  proposals.

### Editor and workspace

- **Worktree** — `src/tool/worktree.ts` (list / enter / exit) for parallel work in git worktrees.
- **Notebook edit** — `src/tool/notebook-edit.ts` edits Jupyter notebooks with a structured diff
  view in the TUI.

### TUI

- Per-tool glyphs (`toolIcons`), with `⚙` kept for MCP / plugin / unknown tools.
- New dialogs: cron, memory, activity, job detail, compact-from / compact-window, side question.
- Session timeline and activity views.

## Building

The build embeds the reported version into the binary. Set `SIXFINGER_VERSION` so the binary reports
a real release version:

```bash
cd packages/sixfinger
SIXFINGER_VERSION="1.18.31" bun run build --single --skip-install
```

Output: `dist/sixfinger-windows-x64/bin/sixfinger.exe` (or the matching target directory).

> **Why the version matters:** the sixfinger Zen free tier rejects clients older than `1.17.0` with
> `HTTP 426 UpgradeRequired` ("SixFinger 1.17.0 or newer is required to use the free tier"), and
> rejects non-streaming requests with `HTTP 403 FreeTierError`. A build that reports
> `0.0.0-dev-<date>` cannot use the free tier.

## Verifying a build

```bash
cd packages/sixfinger && bun typecheck
cd packages/tui && bun typecheck
```

## Windows note

A running executable cannot be overwritten on Windows, but it can be renamed. To update a global
install:

```powershell
Rename-Item C:\Users\<you>\.sixfinger\bin\sixfinger.exe sixfinger.exe.stale
Copy-Item dist\sixfinger-windows-x64\bin\sixfinger.exe C:\Users\<you>\.sixfinger\bin\sixfinger.exe
```

The old file can be deleted once the previous processes have exited.

## License

Upstream sixfinger is MIT licensed. See [`LICENSE`](./LICENSE).

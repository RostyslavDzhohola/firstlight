# FIRSTLIGHT run status

**Run start:** 2026-10-12T00:45:59Z (19:45 CDT, 11 Oct). `caffeinate -dimsu` PID 38667.
**Resume protocol:** SPEC §0. Read this file, check running tasks, continue at the first unchecked item.

## Infra

| Thing | State |
|---|---|
| GitHub repo | `RostyslavDzhohola/firstlight` (private), branch `main` |
| Railway | project `firstlight`, service `game-server`, volume `/data` 5 GB, US East, 2 vCPU/2 GB, Hobby; live at https://api.firstlight.one4all.dev (ALLOW_DEV_GUESTS=1 until auth lane merges) |
| Vercel | not yet |
| Cloudflare | account `rosty-build` workers.dev; Workers token saved; TURN key pending owner |
| Resend | paid plan; domain firstlight.one4all.dev added, DNS added, verification pending; sending key not yet created |

## Milestones

- [ ] M0 Setup and skeleton
  - [x] caffeinate, start time
  - [x] Railway project + service + volume
  - [ ] workspace scaffold, docs, AGENTS.md
  - [ ] Vercel project + domain + DNS
  - [ ] Railway domain + DNS + env
  - [ ] Cloudflare (account, workers.dev, token, TURN) — Codex
  - [ ] Resend domain + DNS + key — Codex + builder
  - [ ] hello-world deploys (client, server /healthz, worker asset, WS round trip)
- [ ] M1 Renderer gate G1
- [ ] M2 Walking multiplayer world
- [ ] M3 Combat core
- [ ] M4 Accounts and persistence
- [ ] M5 Voice
- [ ] M6 Content
- [ ] M7 Look and assets
- [ ] M8 Social and operations
- [ ] M9 Hardening
- [ ] M10 Video-ready
- [ ] M11 Extras

## Lanes (who owns what right now)

| Lane | Owner | Worktree / task | Paths |
|---|---|---|---|
| Dashboards | Codex | fl-run-codex-dashboards-1 | — |

## Measured numbers

(none yet)

## Open issues

- NO CODEX COMPUTER USE (D23): visual/E2E checks run in T3 Code's built-in browser (preview tools). Never Chrome.
- Concept art not generated yet (Codex task cancelled for safety). Retry only without computer use.
- Character floats slightly above terrain (Codex first look) — investigate.
- Cloudflare: Workers token OK (D24). TURN key pending the owner (save-turn-key.sh).
- Resend domain records added; key `firstlight-server` to create after verification.

# FIRSTLIGHT run status

**Run start:** 2026-10-12T00:45:59Z (19:45 CDT, 11 Oct). `caffeinate -dimsu` PID 38667.
**Resume protocol:** SPEC §0. Read this file, check running tasks, continue at the first unchecked item.

## Infra

| Thing | State |
|---|---|
| GitHub repo | `RostyslavDzhohola/firstlight` (private), branch `main` |
| Railway | project `firstlight` (34985681-…), service `game-server` (3aa5094e-…), volume `/data` (7c8af5f6-…), region us-east requested |
| Vercel | not yet |
| Cloudflare | Codex task `fl-run-codex-dashboards-1` running |
| Resend | Codex task `fl-run-codex-dashboards-1` running |

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

(none yet)

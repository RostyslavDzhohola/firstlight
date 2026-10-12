# FIRSTLIGHT run status

**Run start:** 2026-10-12T00:45:59Z (19:45 CDT, 11 Oct). `caffeinate -dimsu` PID 38667.
**Resume protocol:** SPEC §0. Read this file, check running tasks, continue at the first unchecked item.

## Infra

| Thing | State |
|---|---|
| GitHub repo | `RostyslavDzhohola/firstlight` (private), branch `main` |
| Railway | project `firstlight`, service `game-server`, volume `/data` 5 GB, US East, 2 vCPU/2 GB, Hobby; live at https://api.firstlight.one4all.dev (ALLOW_DEV_GUESTS=1 until auth lane merges) |
| Vercel | project `playfirstlight`, https://firstlight.one4all.dev live (A record added), /api/auth + /admin + /stats proxied with origin secret |
| Cloudflare | account `rosty-build` workers.dev; Workers token saved; TURN key pending owner |
| Resend | paid plan; domain firstlight.one4all.dev added, DNS added, verification pending; sending key not yet created |

## Milestones

- [x] M0 Setup and skeleton (live client + server; dev-guest tokens disabled in prod 03:40Z)
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
| Render look + G1 gate | Opus sub-agent | DONE on lane/render (11 commits), awaiting review + merge | apps/client/src/render, world/Planet.ts, shared props.ts |
| Accounts + persistence | Opus sub-agent | MERGED 61aa332 | apps/server/src/auth, db |
| Enemies, wildlife, bosses | Opus sub-agent | ../fl-wt-npc (lane/npc) | server world/npc, client world/npcs, shared content/npcs.ts |
| Voice + radio + phrase wheel | Opus sub-agent | ../fl-wt-voice (lane/voice) | server world/voice, client voice |
| Social, moderation, stats, share | Opus sub-agent | ../fl-wt-social (lane/social) | parties, player list, /admin, /stats, screenshot |
| Missions, medals, eggs, shop, pads, stage | Opus sub-agent | ../fl-wt-quests (lane/quests) | content missions/medals, server systems, map |
| Characters (GLB, animations) | Opus sub-agent | ../fl-wt-chars (lane/chars) | Avatars.ts, assets-dev/characters, tools/blender |
| UI design competition | judged: Opus entry B base, Fable entry A for landing/loading/player list/onboarding | ../design/opus (base) | port to apps/client/src/ui |
| Review combat+auth | done; fixes in D26 | docs/reviews/2026-10-12-* | — |
| Audio (SFX + generative music) | Builder | main | apps/client/src/audio |
| UI port (design verdict) | Opus sub-agent | ../fl-wt-ui (lane/ui, based on lane/render + main) | apps/client/src/ui, index.html, main.ts |
| Review lane/render | Codex Sol high + Opus | delegate fl-review-render-sol-1 + agent | — |
| Destruction (§6.9) | Opus sub-agent | ../fl-wt-destruct (lane/destruct, main+render) | shared breakables.ts, server destruction.ts, client Breakables/debris |
| Photo mode + F2 load test | Builder | ../fl-wt-photo / tools/bots | game/PhotoMode.ts |

## Measured numbers

- 02:55Z local load test (M1, dev server, no NPCs yet): 40 bots joined Arcadia in 4.1 s, 0 failures;
  36-bot room tick p50 0.55 ms / p95 1.74 ms / max 3.74 ms; RSS 162 MB; downstream 21.8 KB/s per bot
  (0.08 GB per player-hour → ≈ $0.004 per player-hour of Railway egress at $0.05/GB). Optimise in M9.

## Open issues

- NO CODEX COMPUTER USE (D23): visual/E2E checks run in T3 Code's built-in browser (preview tools). Never Chrome.
- Concept art not generated yet (Codex task cancelled for safety). Retry only without computer use.
- Character floats slightly above terrain (Codex first look) — investigate.
- Cloudflare: Workers token OK (D24). TURN key pending the owner (save-turn-key.sh).
- Resend domain records added; key `firstlight-server` to create after verification.

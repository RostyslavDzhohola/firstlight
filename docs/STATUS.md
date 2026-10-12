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

## Finish line (SPEC §1)

| # | State | Evidence |
|---|---|---|
| F1 live | ✅ | https://firstlight.one4all.dev + api health; T3 browser loads and plays |
| F2 40 bots | ✅ | 600 s, 0 failures, tick p95 ≤ 2.94 ms with NPCs (Measured numbers) |
| F3 < 30 s to play | ✅ | 8.0 s landing → playing (probe 3.5 s, warm-up 2.2 s), T3 browser, 03:20Z |
| F4 fighting | ✅ | browser E2E T2 PvE + PvP (docs/e2e-2026-10-12.md) |
| F5 death + own pile | ✅ | browser E2E T3 |
| F6 voice | ⛔ | built + tested with bots; needs owner's TURN key; mic E2E needs two real browsers |
| F7 email sign-in | 🟡 | browser E2E T5 passes locally (dev outbox); production waits for Resend domain verification (owner) |
| F8 2-player boss | ✅ | browser E2E T6: Tidewrath killed by two players (admin heals) |
| F9 screenshot share | ✅ | browser E2E T7 |
| F10 M1 ≥ 60 fps Medium | ✅* | ?bench=g1 59.9 fps p50, p95 17.6 ms (T3 Chromium, not plugged-in Chrome) |
| F11 Low on weak profile | ✅* | `?bench=g1&tier=low&cpuslow=4`: 51.3 fps p50, p95 29.8 ms, 0 shader builds (D29 emulation) |
| F12 three-model review | 🟡 | per-lane reviews done; whole-codebase review after the last merges |
| F13 photo mode + 5 scenes | ✅ | browser E2E T8; `stage <n>` + docs/staged-scenes.md |

## Lanes (who owns what right now)

| Lane | State | Where |
|---|---|---|
| Render look + G1 gate | MERGED a59d992 (Codex + Opus reviewed, fixed) | — |
| Accounts + persistence | MERGED 61aa332 | — |
| Social, moderation, stats, share | MERGED 1a2ee50 (Codex ×2) | — |
| Enemies, wildlife, bosses | MERGED 7768535; fixing Codex review (3 blockers) | ../fl-wt-npc |
| Characters (GLB, animations) | MERGED 2447afe; fixing Codex review | ../fl-wt-chars |
| Voice + radio + phrase wheel | MERGED d40d058 (Codex ×2); TURN key pending owner | — |
| Missions, medals, eggs, shop, pads, stage | MERGED f8514dc (Codex) | — |
| Photo mode | MERGED 4214419 | — |
| UI port (design verdict) | Opus sub-agent, merging main then restyling lanes' panels | ../fl-wt-ui |
| Destruction (§6.9) | Opus sub-agent | ../fl-wt-destruct |

## Measured numbers

- 02:55Z local load test (M1, dev server, no NPCs yet): 40 bots joined Arcadia in 4.1 s, 0 failures;
  36-bot room tick p50 0.55 ms / p95 1.74 ms / max 3.74 ms; RSS 162 MB; downstream 21.8 KB/s per bot
  (0.08 GB per player-hour → ≈ $0.004 per player-hour of Railway egress at $0.05/GB). Optimise in M9.

- 02:40Z F2 on production (Railway 2 vCPU/2 GB, commit c26efad, no NPCs merged yet): 40 load-test bots
  on one Arcadia copy for 600 s with `--fire`, 0 failures/disconnects; tick p50 ≤ 0.65 ms, p95 ≤ 1.88 ms,
  max 10.2 ms (limit p95 ≤ 25 ms); RSS ≤ 192 MB; CPU ≈ 6 % of one core; downstream 11.7 KB/s per bot on
  average (0.043 GB per player-hour). Re-run with NPCs (03:10Z, commit d40d058): 40 bots × 600 s, 0 failures, tick p50 ≤ 1.36 ms, p95 ≤ 2.94 ms, max 5.7 ms, RSS ≤ 218 MB, CPU ≈ 6 %, 8.3 KB/s per bot. **F2 passes.**

- 03:13Z G1 / F10 stand-in: `?bench=g1` on the live site in T3 Code's built-in browser (Chromium 152 /
  Electron 44, WebGPU) on the owner's MacBook Air M1, 1785×1048 canvas, Medium, 40-avatar crowd with
  particle bursts, Portus, 180 s warm-up + 60 s run: **59.9 fps p50, frame p95 17.6 ms, p99 19.4 ms,
  max 78.8 ms, 0 shader builds during the run**, draws mean 296 / max 445, 1.05 M triangles,
  104,699 grass blades, heap ≤ 132 MB. Not plugged-in Chrome as SPEC asks (D23: no Chrome control),
  but same machine and Chromium engine. It exposed a GPU-timer bug (fixed: probe would have picked Low).

- 03:45Z F11 stand-in: `?bench=g1&tier=low&cpuslow=4` (4× main-thread slowdown emulation, D29),
  Low, 1125×661 internal (more pixels than the 1280×720 profile), 40-avatar crowd, 60 s warm + 60 s:
  **51.3 fps p50 (mean 47.5), frame p95 29.8 ms, p99 35.7 ms, 0 shader builds**, draws mean 174.

## Open issues

- NO CODEX COMPUTER USE (D23): visual/E2E checks run in T3 Code's built-in browser (preview tools). Never Chrome.
- Concept art not generated yet (Codex task cancelled for safety). Retry only without computer use.
- Character floats slightly above terrain (Codex first look) — investigate.
- Cloudflare: Workers token OK (D24). TURN key pending the owner (save-turn-key.sh).
- Resend: DNS records are live on Vercel DNS (checked against ns1.vercel-dns.com and 8.8.8.8), but Resend still says the domain is unverified (02:45Z). The send-only key is set on Railway, so mail turns on as soon as the domain verifies. **Owner: press "Verify" on resend.com/domains** (the builder's key is send-only, so it can't trigger verification).

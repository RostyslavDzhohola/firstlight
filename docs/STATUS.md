# FIRSTLIGHT run status

**Run start:** 2026-10-12T00:45:59Z (19:45 CDT, 11 Oct). `caffeinate -dimsu` PID 38667.
**Resume protocol:** SPEC §0. Read this file, check running tasks, continue at the first unchecked item.

## Infra

| Thing | State |
|---|---|
| GitHub repo | `RostyslavDzhohola/firstlight` (private), branch `main` |
| Railway | project `firstlight`, service `game-server`, volume `/data` 5 GB, US East, 2 vCPU/2 GB, Hobby; live at https://api.firstlight.one4all.dev (dev guest tokens off: `main.ts` refuses to boot production with `ALLOW_DEV_GUESTS` set) |
| Vercel | project `playfirstlight`, https://firstlight.one4all.dev live (A record added), /api/auth + /admin + /stats proxied with origin secret |
| Cloudflare | account `rosty-build` workers.dev; Workers token saved; TURN key pending owner |
| Resend | paid plan; domain firstlight.one4all.dev added, DNS added, send-only key set on Railway; **verification pending the owner** |

## Milestones

Checked = the milestone's "done when" (SPEC §8) is met; the notes say what is still open. Checked
against the repo, the finish-line table and the lane table on 2026-10-12 (F12 docs lane).

- [x] M0 Setup and skeleton (live client + server; dev-guest tokens disabled in prod 03:40Z)
  - [x] caffeinate, start time
  - [x] Railway project + service + volume
  - [x] workspace scaffold, docs, AGENTS.md, README.md (no CONTRIBUTING.md yet)
  - [x] Vercel project + domain + DNS
  - [x] Railway domain + DNS + env
  - [ ] Cloudflare: account, workers.dev and Workers token done (D24); **TURN key pending the owner**
  - [ ] Resend: domain, DNS and send-only key done; **domain verification pending the owner**
  - [x] hello-world deploys: client, server `/healthz`, WebSocket round trip (F1); the asset Worker
    (`apps/assets-worker`) deploy isn't recorded here
- [x] M1 Renderer gate G1: WebGPU kept; `?bench=g1` 59.9 fps p50, p95 17.6 ms on the M1 (Measured
  numbers, D29). The WebGL2 fallback run isn't recorded.
- [x] M2 Walking multiplayer world (two-browser E2E on a local stack; T1 on production). Player state
  is not view-filtered (D30).
- [x] M3 Combat core (E2E T2 PvE + PvP, T3 death + own pile)
- [ ] M4 Accounts and persistence: merged 61aa332; E2E T5 passes locally. Open: a real OTP email on
  production needs Resend's domain verified (owner).
- [ ] M5 Voice: merged d40d058, tested with bots. Open: E2E T4 needs the owner's TURN key and two
  real browsers with microphones.
- [x] M6 Content: all content lanes merged; E2E T2 and T6 pass. The F12 content fixes (egg-spawn
  caps, Prism Bubble, Patchkit, drop ids, Hollow King solo protection, real-path medal/egg tests)
  merged in c57d406.
- [ ] M7 Look and assets: render look, characters, the UI port and the onboarding tutorial +
  training dummies (1c30f4e, seen live on a fresh guest) merged. Open: concept art (not generated),
  a per-body visual check.
- [x] M8 Social and operations (merged 1a2ee50; E2E T7 passes). The `/stats` test-session check
  isn't recorded.
- [ ] M9 Hardening: F2 load test, perf pass (F10/F11) and the E2E run (T4 blocked) done.
  - [x] F12 three-model review: blockers fixed, all three reviewers sign off (b274af9)
  - [ ] Security pass (auth flows, rate limits, admin routes, input validation, no secrets in the bundle)
  - [ ] Voice launch items from docs/risk-assessment.md §5: a public complaints/appeals contact and
    a terms page (voice rules, 16+). Admin voice-mutes are persisted in game.db (migration 5, 668ec82).
  - [ ] Before the repo goes public: docs/pre-public.md (owner)
- [ ] M10 Video-ready: photo mode, `stage <n>` and docs/staged-scenes.md done (F13). Open: the landing
  flythrough video, the final report to the owner (SPEC §12).
- [ ] M11 Extras: photo mode (#1) done; weather + day/night (#3–4) merged 743d651; horses (#2)
  merged acdfcb3; more cosmetics and Easter eggs (#5) merged (8 cosmetics, eggs E10–E12). Final report: docs/final-report.md.

## Finish line (SPEC §1)

| # | State | Evidence |
|---|---|---|
| F1 live | ✅ | https://firstlight.one4all.dev + api health; T3 browser loads and plays |
| F2 40 bots | ✅ | re-run on 668ec82 (all F12 fixes, 08:45Z): 40 bots × 600 s with --fire, 0 failures, tick p95 ≤ 2.86 ms, max 6.67 ms (Measured numbers) |
| F3 < 30 s to play | ✅ | 8.0 s landing → playing (probe 3.5 s, warm-up 2.2 s), T3 browser, 03:20Z |
| F4 fighting | ✅ | browser E2E T2 PvE + PvP (docs/e2e-2026-10-12.md) |
| F5 death + own pile | ✅ | browser E2E T3 |
| F6 voice | ⛔ | built + tested with bots; needs owner's TURN key; mic E2E needs two real browsers |
| F7 email sign-in | 🟡 | browser E2E T5 passes locally (dev outbox); production waits for Resend domain verification (owner) |
| F8 2-player boss | ✅ | browser E2E T6: Tidewrath killed by two players (admin heals) |
| F9 screenshot share | ✅ | browser E2E T7 |
| F10 M1 ≥ 60 fps Medium | ✅* | re-run on 668ec82 (weather, NPCs, horses, collision): ?bench=g1 59.9 fps p50, p95 18.6 ms; night storm 59.9 fps p50, p95 18.5 ms; 0 shader builds (T3 Chromium, not plugged-in Chrome) |
| F11 Low on weak profile | ✅* | re-run on 668ec82: `?bench=g1&tier=low&cpuslow=4`: 59.2 fps p50 (mean 57.0), p95 21.9 ms, p99 25.6 ms, 0 shader builds (D29 emulation) |
| F12 three-model review | ✅ | **All three sign off on b274af9** (docs/reviews/2026-10-12-f12-confirm-{codex-sol,opus-5-5,sonnet-5-5}.md). Round 1: Codex 7, Sonnet 2, Opus 2 blockers; final round: Codex 2, Opus 1; all fixed and verified closed by probes. Remaining should-fixes in lane/t9-fixes and lane/f12-polish |
| F13 photo mode + 5 scenes | ✅ | browser E2E T8; `stage <n>` + docs/staged-scenes.md |

## Lanes (who owns what right now)

| Lane | State | Where |
|---|---|---|
| Render look + G1 gate | MERGED a59d992 (Codex + Opus reviewed, fixed) | — |
| Accounts + persistence | MERGED 61aa332 | — |
| Social, moderation, stats, share | MERGED 1a2ee50 (Codex ×2) | — |
| Enemies, wildlife, bosses | MERGED 7768535 + review fixes ec3f110 (deployed) | — |
| Characters (GLB, animations) | MERGED 2447afe + review fixes 13cf0f5 | — |
| Voice + radio + phrase wheel | MERGED d40d058 (Codex ×2); TURN key pending owner | — |
| Missions, medals, eggs, shop, pads, stage | MERGED f8514dc (Codex) | — |
| Photo mode | MERGED 4214419 | — |
| UI port (design verdict) | MERGED 9f6dc14 (deployed) | — |
| Destruction (§6.9) | MERGED bb54dc3 (deployed) | — |
| Weather + day/night (M11 #3–4) | MERGED 743d651 (deployed 06:39Z) | — |
| F12 server core (Codex B1–B6, S2/S3/S9/S10/S12/S14) | MERGED 668ec82 (Codex round 1 fixed; migration 5) | — |
| F12 content (eggs, items, Patchkit, Prism Bubble, Hollow King, Associates look) | MERGED c57d406 (Codex round 1 fixed; migration 4) | — |
| F12 client robustness (S4–S8, N1, Opus 13–14) | MERGED b020746 (Codex round 1 fixed) | — |
| F12 docs + repo hygiene | MERGED 8535ae7 | — |
| F12 inventory panel + onboarding | MERGED 1c30f4e (Codex round 1 fixed; live: onboarding seen on a fresh guest) | — |
| F12 social/voice (Opus B1, block/party, reports, OTP, guest pruning) | MERGED c45f556 (Codex round 1 fixed) | — |
| F12 NPC/boss (Opus B2 respawn persistence, evade, arena scaling/cover, NPC LOS) | MERGED f787f37 (Codex round 1 fixed; migration 3 = copy_state) | — |
| F12 weather/sky (override broadcast, stage sky, Hollowmere look, nits) | MERGED 5e9d5ce (Codex round 1 fixed) | — |
| Horses (M11 #2) | MERGED acdfcb3 (deployed; Codex-reviewed) | — |
| F12 round 2: payouts, teleport, movement sweep, quest/onboarding nits | MERGED b274af9 | — |
| F12 round 2: auth/social (OTP enumeration and drain, self-delete, prune) | MERGED ae6810b | — |
| T9 findings + confirmation should-fixes (save prompt, portal step, warm-up, payout retry, names, dodge, camera) | MERGED 1c39649 (Codex-reviewed; T9 re-run passes) | — |
| F12 polish (prop-top climb, public OTP budget, load-test pickup, origin-check pin) | MERGED a2f407f (deployed 11:47Z; 1014 tests) | — |
| M11 #5 more cosmetics + 3 Easter eggs | MERGED (Codex-built, Codex-reviewed; atomic egg claims for all eggs) | — |
| Chrome play-test: black world after Settings → Low | MERGED c9ddf29 (deployed) | — |
| Chrome play-test UX (tutorial HUD + T toggle, map labels, menu hints, hostile spawns ≥ 45 m off pads, keyed NPC copy state) | MERGED 9356edb (Codex ×2; deployed 16:08Z; 1081 tests). Deferred nit: OnboardingClient lifecycle tests | — |
| Vegetation (CC0 Quaternius trees/undergrowth, impostors, wind; Medium meshes to 30 m) | MERGED 868fb34 (Codex rounds 1–4; hardware-GPU A/B: no frame-time regression, draws +1–13 %; 1106 tests) | — |
| Portus castle town (Opus 5.5 Blender design; flat floor, shared colliders, 2.8 MB packed town, protocol 3) | MERGED 3eda935 (Codex code ×3 + browser ×3; Medium no measured cost, Low cpuslow=4 p50 60 fps, p95 18.6 → 23.9 ms; 1162 tests) | — |
| Tutorial HUD polish from the live run-through (scrolling list, edge-arrow callouts, moved-on tips, sprint counter) + shader-monitor warm-up fix | MERGED 7aaa796 (Codex code+browser ×3; deployed; 1173 tests) | — |
| Landing pads + pad-0 arrival outposts (Arcadia Dawnpad, Hollowmere Lanternfall, Meridian Waystation 9) | Opus design approved (/tmp/fl-design-pads); Opus integrating (structure sites, D42–D45, protocol 4) | fl-wt-pads, lane/pad-outposts |

## Measured numbers

- 09:30Z F11 re-run on the live site at 668ec82: `?bench=g1&tier=low&cpuslow=4` (4× main-thread slowdown, D29),
  Low, 1125×661 internal, 40-avatar crowd, 180 s warm + 60 s: **59.2 fps p50 (mean 57.0), frame p95 21.9 ms, p99
  25.6 ms, max 40.5 ms, 0 shader builds**, draws mean 182 (was 51.3 fps p50 / p95 29.8 ms at 03:45Z; the cause of the
  improvement wasn't isolated, the F12 client lane's per-frame-allocation removal is one candidate).

- 09:20Z F10 re-run on the live site at 668ec82 (all F12 fixes + weather/day-night, horses, prop collision), T3 Code's
  built-in browser (Chromium/WebGPU) on the owner's M1, 1785×1048 canvas, Medium, `?bench=g1` (180 s warm + 60 s):
  **59.9 fps p50 (vsync-capped), frame p95 18.6 ms, p99 18.7 ms, max 20.5 ms, 0 shader builds**, draws mean 288,
  1.05 M triangles. Night storm pass (`&weather=storm&time=0`, Portus 00:00 storm 90 %): **59.9 fps p50, p95 18.5 ms,
  max 18.8 ms, 0 shader builds**, draws mean 332. Two agent test suites were running on the same machine.

- 08:45Z F2 re-run on production at 668ec82 (every F12 fix, NPCs, destruction, weather, horses): 40 load-test bots on one
  Arcadia copy for 600 s with `--fire`: 0 failures/disconnects, 40/40 clients in all 22 samples; tick p50 ≤ 1.27 ms,
  p95 ≤ 2.86 ms, max 6.67 ms (limit p95 ≤ 25 ms); RSS ≤ 218 MB; CPU ≈ 5.9 % of one core; 7.8 KB/s per bot
  (0.029 GB per player-hour). **F2 still passes.**

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

- Flaky under full-suite load (pass alone 3/3): voice "relays far apart on the same channel…" failed once (81 ms) in a full run at 04:50Z; watching.

- NO CODEX COMPUTER USE (D23): visual/E2E checks run in T3 Code's built-in browser (preview tools). Never Chrome.
- Concept art not generated yet (Codex task cancelled for safety). Retry only without computer use.
- Character floats slightly above terrain (Codex first look) — investigate.
- Cloudflare: Workers token OK (D24). TURN key pending the owner: the saved API token has no Calls permission (06:45Z check), so create the key in the dashboard (Realtime → TURN) and run save-turn-key.sh.
- Resend: DNS records are live on Vercel DNS (checked against ns1.vercel-dns.com and 8.8.8.8), but Resend still says the domain is unverified (02:45Z). The send-only key is set on Railway, so mail turns on as soon as the domain verifies. **Owner: press "Verify" on resend.com/domains** (the builder's key is send-only, so it can't trigger verification).

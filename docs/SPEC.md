# FIRSTLIGHT build spec

Status: **draft for owner confirmation** (11 Oct 2026). Nothing is built until the owner says "execute".

This is the single source of truth for the autonomous build run. It is written for the builder
(Claude Opus 5.5 in this thread) and for every sub-agent it dispatches. Decisions and their
reasons live in `DECISIONS.md`; this file says what to build, in what order, and how we know it's done.

---

## 0. Read me first (resume protocol)

The run lasts ~20 hours and the builder's context will be compacted many times. After every
compaction, and before every milestone:

1. Re-read §0, the milestone you're on (§8), and `docs/STATUS.md` (in the repo; created in M0).
2. Check running background work (sub-agents, Codex tasks, dev servers) before starting new work.
3. Continue with the first unchecked item in `docs/STATUS.md`.

**Files** (copied into the repo under `docs/` during M0; the copies in the repo are canonical from then on):

| File | Purpose |
|---|---|
| `SPEC.md` | What to build, order, acceptance checks |
| `DECISIONS.md` | Owner decisions + run decisions (append `D<n>` entries with the reason) |
| `docs/STATUS.md` | Live progress: milestone checklist, run start time, current lane owners, open issues, measured numbers |
| `research/spec-extract-content.md` → `docs/content.md` | Content bible: numbers for weapons, enemies, bosses, progression, missions, eggs, medals |
| `research/spec-extract-tech.md` → `docs/tech-facts.md` | Verified versions, APIs and service limits |
| `research/r2-11`, `r2-13`, `r2-14`, `r2-15`, `r2-16` | Background: planets, voice, auth, look, reference tricks |

**Golden rules for the run**

- Never stop to ask. Decide, log a `D<n>` entry in `DECISIONS.md`, keep going. Stop only for the
  four stop conditions in §11.
- Never print or commit secrets. Secrets live in `~/.config/firstlight/.env` (chmod 600) and in
  Railway/Vercel/Cloudflare env settings. Load with `set -a; . ~/.config/firstlight/.env; set +a`.
- Never send the owner's email address to any service except as the Cloudflare sign-up address if
  a new account is needed (owner-approved in R4 Q2).
- Commit early and often with the attribution line from the system reminder. Deploy continuously.
- Every number you report to the owner comes from a command or measurement in this run.
- Before claiming background work is done, check its exit status and read its output.
- Measure before optimising; keep the perf overlay and kill-switch flags working at all times.

---

## 1. Goal and finish line

**Goal:** a beautiful, playable, persistent multi-planet multiplayer open world at `https://firstlight.one4all.dev`
that the owner can share as a link and film for a video: one life, wild-west PvP outside safe
zones, co-op bosses, proximity voice, three planets and a hub.

**Finish line** (all must pass; from R4 Q11 as amended by Q15):

| # | Check | How it's verified |
|---|---|---|
| F1 | Live at `firstlight.one4all.dev`; server at `api.firstlight.one4all.dev` | `curl` health + Codex opens it |
| F2 | 40 bot players on one planet copy don't break the server (tick p95 ≤ 25 ms, no disconnects for 10 min) | `tools/bots` load test against production |
| F3 | Landing → playing in < 30 s (first visit, cold cache) | Codex E2E card T1 |
| F4 | Fighting (PvE and PvP) works | Codex E2E card T2 |
| F5 | Death, then looting your own pile after rebirth | Codex E2E card T3 |
| F6 | Proximity voice between two browsers, plus the radio | Codex E2E card T4 |
| F7 | Email sign-in, then the same character in a second browser | Codex E2E card T5 |
| F8 | A 2-player boss kill | Codex E2E card T6 (two browser windows) |
| F9 | Screenshot share works | Codex E2E card T7 |
| F10 | ≥ 60 fps on Medium on the owner's MacBook Air M1 in the busiest scene, after 3 min warm-up | `?bench` run by Codex on the M1 |
| F11 | Low tier playable (≥ 30 fps) on the weak-laptop profile (§7.4) | `?bench&tier=low` with the profile |
| F12 | Three-model review (Codex Sol 6.1 high, Opus 5.5, Sonnet 5.5) signs off, blockers fixed | Review reports in `docs/reviews/` |
| F13 | Photo mode works; 5 staged scenes ready to record | Codex E2E card T8 + `docs/staged-scenes.md` |

After the finish line, keep going with the extras (§8, M11) until the owner stops the run.

---

## 2. System overview

```
Browser (desktop Chrome/Edge/Safari/Firefox)
  │
  ├── https://firstlight.one4all.dev  (Vercel Hobby, project `playfirstlight`;
  │     playfirstlight.vercel.app redirects here — it's a separate cookie jar)
  │     index.html + landing (static, < 300 KB) → game bundle (JS, hashed, immutable)
  │     /api/auth/*  ── Vercel `routes` proxy + x-origin-secret ──►  api.firstlight.one4all.dev/api/auth/*
  │     (keeps the session cookie first-party: Safari caps cookies set by the CNAME'd API host at 7 days)
  │
  ├── https://firstlight-assets.<acct>.workers.dev  (Cloudflare Workers static assets, free, unlimited requests)
  │     /v/<buildId>/… GLB (meshopt) / KTX2 / audio / LUTs / video — immutable, CORS *; previous build kept
  │
  ├── https://api.firstlight.one4all.dev  (Railway Hobby, us-east4; 2 vCPU / 2 GB replica limit; one replica)
  │     Node 24 LTS: Express 5 + Better Auth 1.7.7 (anonymous, emailOTP, jwt) + Colyseus 0.18.9
  │     POST /api/play (Bearer JWT → seat reservation) · wss:// rooms (no token in URL)
  │     /api/online · /api/queue · /admin · /stats · /healthz
  │     volume /data (≤ 5 GB on Hobby): auth.db, game.db (better-sqlite3 13, WAL)
  │     ├──► Resend API (login@firstlight.one4all.dev; sending-only key scoped to that domain)
  │     └──► Cloudflare Realtime TURN API (mints per-player relay credentials, 12 h TTL)
  │
  └── WebRTC audio, peer↔peer, relay-only through Cloudflare TURN (players never see IPs)
```

**Why this shape:** Vercel serves only the shell and code (~2–3 MB per first visit), so Hobby's
100 GB covers tens of thousands of visits; heavy files come from Cloudflare's free static assets;
one Railway service holds all game state, auth and the database so there's nothing to keep in sync.

---

## 3. Repository

`github.com/RostyslavDzhohola/firstlight` (private until the owner says go public). pnpm workspace,
TypeScript everywhere, ESM, **Node 24 LTS pinned** (`engines.node: "24.x"` + `RAILPACK_NODE_VERSION=24`;
Railway's default "lts" becomes Node 26 on 28 Oct).

**Pins** (exact, from `docs/tech-facts.md` §1; lockfile committed): three 0.186.1, @types/three 0.186.0,
colyseus 0.18.9, @colyseus/core 0.18.18, @colyseus/schema 5.0.36, @colyseus/ws-transport 0.18.4,
@colyseus/tools 0.18.9, **@colyseus/sdk 0.18.5** (never `colyseus.js`, never `@next` tags), better-auth 1.7.7,
better-sqlite3 13.0.3, express 5.3.0, jose 6.2.12, resend 6.32.1, zod 4.6.6, esbuild 0.28.2, tsx 4.23.15,
vite ^8.3.4, @dgreenheck/three-pinata 2.0.1, @gltf-transform/* 4.5.1,
meshoptimizer 1.3.0, zzfx 1.4.0 (+ a `declare module` shim), vitest 5.0.3, playwright 1.64.0,
wrangler 4.149.0, typescript 7.0.2 (**typecheck only** — no compiler API; Vite/Vitest/tsx transpile).
TS 7 defaults: `types: []` (list them), no `baseUrl`, `moduleResolution: bundler` (client) / `nodenext`
(server). Colyseus state uses `schema()`/`t.*` builders, not decorators. No Rapier unless D8 is revisited.
No React, React DOM, Zustand or `@vitejs/plugin-react`: the UI is plain DOM + CSS (D25).

```
firstlight/
  apps/
    client/            Vite app: landing, game, UI (plain DOM + CSS, D25), renderer (three WebGPU + TSL)
    server/            Express + Better Auth + Colyseus rooms + SQLite + admin/stats pages
    assets-worker/     Cloudflare Worker static-assets project (wrangler.toml, _headers); serves assets/dist
  packages/
    shared/            Deterministic, isomorphic code: planet height fn, movement rules, combat math,
                       XP/coins, content data (weapons, enemies, bosses, items, missions, medals),
                       net message types, config constants. No DOM, no three.
  tools/
    blender/           Headless Blender scripts (blender -b -P) that build/restyle GLBs
    pipeline/          gltf-transform scripts: meshopt, KTX2 (ETC1S colour, UASTC normals/palettes), hashing, manifest
    bots/              Load-test bots (Colyseus SDK in Node)
    e2e/               Playwright fallback specs (only used when Codex control is down)
    bench/             Bench path definitions + results parser
  assets-src/          Our own sources (.blend, concept art, palettes) — CC BY 4.0
  assets-private/      NOT in git (.gitignore): ElevenLabs outputs; deployed to the Worker only
  docs/                SPEC, DECISIONS, STATUS, content, tech-facts, tests/ (E2E cards), reviews/,
                       staged-scenes.md, risk-assessment.md, ASSETS.md (third-party licence registry)
  AGENTS.md            How AI contributors work in this repo (build, test, conventions, IP line)
  CONTRIBUTING.md      Human-facing version; DCO sign-off; licence notes
  LICENSE              MIT (code)   ·   LICENSE-ART  CC BY 4.0 (our art)
```

**Conventions:** no CI (R1 Q18). `pnpm test` runs vitest across packages. `pnpm dev` runs client
(5173) + server (2567) together. Each sub-agent works in its own git worktree and branch and uses
its own ports (`PORT_OFFSET`). Small PRs; the builder integrates on `main`.

---

## 4. Client

### 4.1 Boot sequence and load budget

1. `index.html` renders the landing page immediately (static HTML/CSS + a poster image; the
   flythrough video starts after first paint). Phones get the "play on your computer" page.
2. **Play** → request fullscreen + pointer lock → show the loading screen → load the game bundle.
3. Create `new WebGPURenderer({ antialias: false, forceWebGL: flags.webgl })`, `await renderer.init()`,
   read `renderer.backend.isWebGPUBackend`. Record the backend in analytics.
4. Auth: `getSession()` first (clears stale cookies, Better Auth #11533), else `signIn.anonymous()`;
   then `token()` → 15-min JWT (§5.4).
5. Load Portus (core bundle). Run the ~2 s quality probe (§7.3), then the **warm-up protocol**:
   set `frustumCulled = false` and force every LOD level on all meshes → `compileAsync(scene, camera)` →
   `compileComputeAsync(nodes)` (WebGPU only) → render 3–5 real frames of the full `RenderPipeline` with
   shadows behind the opaque loading overlay (`compileAsync` alone skips off-camera objects, inactive LODs,
   shadows, and post passes — three #34681). A test hooks `renderer.debug.onNodeBuilderCreated` and asserts
   zero new shader builds over the next 120 frames. Repeat on tier change and on planet arrival.
6. `POST /api/play` → seat reservation → `consumeSeatReservation`; hand control to the player.

**Budgets:** playable within ~20 s on a 50 Mbps first visit; ≤ 25 MB downloaded before control
(target ≤ 12 MB); JS ≤ 1.5 MB gzip on the critical path. Everything else streams: each planet is a
bundle (biome kit GLBs + KTX2 + LUT + audio), prefetched when the player approaches a portal and
finished during the teleport pull-out. Release a planet's GPU resources on departure.

### 4.2 Modules

| Module | Responsibility |
|---|---|
| `render/` | Renderer creation + backend detection, quality tiers, post pipeline (TSL), sky/atmosphere, fog, terrain chunks, grass, trees/rocks, water, particles, characters, destruction debris, perf overlay, kill switches |
| `world/` | Planet scene graph, chunk streaming (Web Worker using `@firstlight/shared` height fn), props from per-chunk hashes, POIs, pads, safe-zone visuals, portals, sky planets |
| `net/` | Colyseus client, room switching, client prediction + reconciliation for the local player, snapshot interpolation (100 ms) for others, message codecs |
| `game/` | Player controller on a sphere, camera, input map, combat (aim, fire, melee, block, charge, scope), inventory/hotbar, pickups, interactions, logout flow, death/rebirth, onboarding script, photo mode |
| `audio/` | WebAudio graph: SFX (ZzFX + CC0 samples), music per planet, positional SFX, boss lines + subtitles |
| `voice/` | `VoiceTransport` interface; P2P mesh implementation (§5.7); LiveKit stub behind the same interface |
| `ui/` | Plain DOM + CSS overlay (D25): landing, loading, HUD (HP, XP, level, coins, hotbar, compass, safe-zone sign, mission tracker, boss bar, speaking indicators), menus, settings, map, inventory, player list, phrase wheel, death screen, character creation, share dialog, toasts |

No React Three Fiber: the 3D layer is vanilla three.js driven by our own loop for direct control of
the WebGPU renderer. UI state bridges through small subscribe-style stores (for example
`world/npcs/bossStore.ts`, wired in `ui/bind.ts`). No ECS library: plain TS entity
maps + systems.

### 4.3 Movement and camera on a sphere

- Each planet is its own scene with the planet centred at the origin (float32 is fine up to 3 km).
- Local up = `normalize(position)`. The player keeps a heading quaternion re-orthonormalised to local
  up every tick. Gravity points to the centre (9.8 m/s² feel, tuned).
- Speeds and combat constants come from `docs/content.md` §0 (run 6 / sprint 9 / swim 3 m/s; dodge-roll
  4.5 m over 0.30 s on **C** (D1) with i-frames and a 1.2 s cooldown; fall damage from 8 m, lethal at
  ~20.5 m, none into deep water). Jump ~1.2 m apex.
- Ground = the shared height function sampled on the rendered triangle (r2-11 §2) + prop colliders
  (capsules/boxes from chunk hashes). Slopes > 50° slide.
- Lakes: below water level you swim (no attacks, slower), surface bob.
- Camera: third person over the right shoulder, collision-pulled toward the player, pitch clamped so
  the curved horizon stays in frame; FOV slider (default 75°); scope zoom for sniper/bow.

### 4.4 Input map

WASD move · mouse aim · LMB attack · RMB aim/block/charge · Shift sprint · Space jump · **C dodge** ·
**R reload** (D13) · 1–4 hotbar · E interact/pick up · Tab player list · V push-to-talk · B radio · G phrase wheel ·
M map · I inventory · P screenshot · F9 photo mode · Esc menu · Shift+Esc panic mute-all ·
F3 perf overlay. `contextmenu` and Tab defaults are suppressed while pointer-locked.

---

## 5. Server

### 5.1 Process

One Node process on Railway: an Express app and the Colyseus server share one HTTP server.

- Express 5 routes, in this order: `/api/auth` middleware (origin-secret gate → copy the first
  `x-forwarded-for` entry into `x-firstlight-client-ip` → `Cache-Control: no-store`), then
  `app.all("/api/auth/*splat", toNodeHandler(auth))`, then `express.json()`, then `POST /api/play`
  (the **only** way into a room, §5.2), `/api/online` (from `matchMaker.stats.local.ccu`, cached 1 s),
  `/api/queue`, `/admin`, `/stats` (admin session), `/healthz`.
- **Colyseus hardening (verified traps):** importing `colyseus` re-exports `@colyseus/auth`, which
  replaces `Room.onAuth` with a `JWT_SECRET` check that admits everyone when unset — so every room
  overrides `static onAuth` to reject, `JWT_SECRET` is never set, and
  `matchMaker.controller.exposedMethods = ["reconnect"]` (no client-side `joinOrCreate`/`joinById`).
  Colyseus' default CORS reflects any origin with credentials on every route — override
  `matchMaker.controller.getCorsHeaders` with an allow-list (`firstlight.one4all.dev`, localhost in dev).
  Messages are validated with zod (`validate(schema, handler)`); `maxMessagesPerSecond = 60`.
- **Deploys restart the only replica** (a volume rules out replicas), so every server deploy
  disconnects everyone. Graceful shutdown on SIGTERM: save every character with a `graceful` flag (no
  30 s body linger, no death), flush boss timers and destruction state, broadcast "Server updating…".
  Clients auto-rejoin via `/api/play` at their saved position with 5 s protection. Deploys must never
  kill a player. Server deploys are batched (D9); client and asset deploys don't disconnect anyone.

### 5.2 Rooms and matchmaking

- One room class `BodyRoom` registered as `defineRoom(BodyRoom).filterBy(["body"])`, with `body` ∈
  `portus | arcadia | hollowmere | meridian`. One room = one copy of one body. `maxClients = 40`.
- Simulation 20 Hz: `this.setTimestep(tick, 50)` **and** `patchRate = 50` (the default timestep is 60 Hz).
  `onDrop` → `allowReconnection(client, 30)` (reconnects skip auth, so bans also check in `onReconnect`).
  `setMetadata` replaces metadata — always spread the old value.
- **`POST /api/play {body, partyLeaderRoomId?}`** (Bearer JWT):
  1. verify with `auth.api.verifyJWT` (returns `{payload: null}` on failure), check the user row still
     exists (guests are deleted on save) and isn't banned;
  2. global cap 320 → else queue (`/api/queue` position; landing polls every 5 s);
  3. pick the room: `matchMaker.query({name: "body", body}, {clients: -1})` (counts reserved seats);
     **solo players only enter copies with fewer than 36 occupants** (4 seats of party headroom; D12); a party only
     enters a copy with room for all members; create the second copy behind a per-body mutex if < 2 exist;
  4. `matchMaker.reserveSeatFor(room, {body}, authPayload)` (skips `onAuth`; payload becomes `client.auth`)
     → the client calls `consumeSeatReservation`. The JWT never appears in a WebSocket URL.
- **Interest management:** Colyseus `StateView` per client, recomputed at 5 Hz from a spatial hash keyed
  by chunk `(face, cx, cy)`, with hysteresis: **players** add ≤ 160 m / remove ≥ 180 m (must exceed the
  150 m sniper range and the ~144 m sightline on Meridian); **NPCs, piles, props** add ≤ 80 m / remove
  ≥ 100 m; always include your own player and party. Hot fields (position, rotation, hp, anim) in the first 32 schema indexes;
  small nested schemas (≤ 8 fields) for per-tick entities. **Measure encode time with 40 bots** — the docs
  call StateView unoptimised for large sets; the fallback is one shared un-viewed player map with views
  only for NPCs, piles and props. NPCs exist only in chunks within ~200 m of some player and despawn
  ~30 s after the last player leaves.
- **Cross-room:** `matchMaker.presence.publish/subscribe` for announcements, party invites, pile pickups
  (subscribers wrapped in try/catch — `publish` runs them synchronously).

### 5.3 Authority and netcode

- **Movement:** client-predicted; the client sends input + resulting position at 20–30 Hz; the server
  validates (max speed incl. dodge/fall, ground height ± 0.3 m, prop colliders, no entering safe-zone
  rules while in combat state) and snaps back on violation (logged). See D3.
- **Hitscan weapons:** the client sends `fire {weaponSlot, origin, dir, clientTime}`; the server rewinds
  target positions (history ≤ 200 ms) and resolves hits. **Projectiles** (arrows, rockets, fireballs,
  grenades) are simulated by the server; the client shows a predicted projectile immediately and
  reconciles. **Melee** uses server-side arcs on the attacker's validated position.
- **Damage, HP, XP, coins, loot, deaths, boss state, destruction state:** server only.
- Remote entities render 100 ms in the past with interpolation; local player reconciles on server ack.
- Message types and codecs live in `packages/shared/net`. WebSocket `maxPayload` 16 KB.

### 5.4 Auth and accounts

Better Auth 1.7.7 inside the server, `baseURL: "https://firstlight.one4all.dev"` (the proxied public
origin; also JWT `iss`/`aud`). Config skeleton: `docs/tech-facts.md` §5. Migrations run at boot via
`getMigrations(auth.options)` (the JWT plugin needs a `jwks` table; SQL must quote `"user"`).

1. **Guest:** `getSession()` → none → `signIn.anonymous()` via the Vercel proxy (first-party, host-only
   cookie on `firstlight.one4all.dev`; session 180 days) → `token()` → 15-min JWT whose payload is set with
   `definePayload` to `{name, guest}` only (the default payload includes the email). `/api/play` verifies it
   in-process (§5.2). `disableSettingJwtHeader: true`.
2. **Save:** after the first level-up, a non-blocking prompt "Save your character" → email → 6-digit OTP
   (`storeOTP: "hashed"`, 5 min, 3 attempts) via Resend from `FIRSTLIGHT <login@firstlight.one4all.dev>`
   (plain text, code in the subject, no links) → `signIn.emailOtp({email, otp, name})` (pass `name`, or the
   guest's name is lost) → `onLinkAccount`. **The account id changes on save:** `onLinkAccount` moves every
   `game.db` row from the guest id to the new id in one idempotent transaction (merge rule if the target
   already has a character: keep the higher-level live character, union medals/blocks/pads) and re-keys live
   room clients.
3. **Second browser:** "Sign in with email" → OTP → same account and character. One live session per
   character: a new join kicks the old one.
4. **Limits:** custom rate rules (`/sign-in/anonymous` 20 per 60 s per IP — the built-in 3 per 10 s would
   block shared networks; `/sign-in/email-otp` 5 per 60 s); our own OTP send budget (≤ 3 per email per hour,
   ≤ 80 per day globally while Resend is on the free plan's 100/day). Better Auth reports success even when
   the send fails, so the budget and the Resend result are checked by us; over budget the UI says "Saving
   is busy, try again later" and the character stays a guest. Resend button disabled for 60 s.
   IP: `ipAddressHeaders: ["x-firstlight-client-ip"]`, set only by the origin-secret-gated middleware.
5. **Admin:** a one-time `ADMIN_CLAIM_TOKEN`. Visiting `/admin/claim?token=…` while signed in makes that
   account admin and burns the token. The claim link is written to
   `~/.config/firstlight/admin-claim.txt` and given to the owner at the end of the run.
6. Display names: chosen at first play; unique (case-insensitive), 3–16 chars `[A-Za-z0-9_]`,
   slur-filtered with an open-source word list (MIT/CC0 package; pick in M4 and record it).

### 5.5 Persistence (SQLite on `/data`)

Driver: **better-sqlite3 13.0.3** (`node:sqlite` is still a release candidate), behind one small
`db/` module. `auth.db` is Better Auth's. Keep both well under Hobby's 5 GB volume cap (prune analytics
older than 90 days). `game.db` tables (WAL mode; writes batched):

| Table | Key columns |
|---|---|
| `account` | user_id, display_name, is_admin, title_medal, created_at, last_seen_at, banned_until |
| `character` | user_id (one live character per account), starter, palette, level, xp, coins, hp, body, copy_hint, pos xyz, heading, inventory_json, mission_state_json, life_started_at, protected_until, updated_at |
| `discovered_pad` | user_id, body, pad_id (account-level, survives death; D2) |
| `medal` | user_id, medal_id, earned_at |
| `hall_of_firsts` | secret_id (PK), user_id, display_name, found_at |
| `pile` | id, body, pos xyz, items_json, coins, owner_name, created_at (cap 1,000 per body; oldest evicted) |
| `block` | user_id, blocked_user_id |
| `report` | id, reporter, target, body, pos, reason, created_at |
| `ban` | user_id, ip_hash, until, reason |
| `session_log` | user_id, started_at, ended_at, body_time_json, deaths, max_level, backend, tier |

Autosave: on level-up, pickup, purchase, death, travel, logout, and every 30 s per character.
Piles are per body (shared by both copies of a planet); pickup is a DB transaction so the first
taker wins, and both copies are notified in-process.

### 5.6 Game rules on the server

Implemented in `apps/server/src/systems/*`, using numbers from `packages/shared/content`:
safe zones (Portus + 12 m pad rings (D15): weapons holstered, no damage, enemies leash out), PvP everywhere
else with friendly fire, level gates for tier 2/3, death → pile → rebirth, logout timers (30 s
countdown, 30 s body linger, 5 s protection), combat-tag (10 s), XP/levels/coins, shop, missions,
medals, Easter eggs + Hall of Firsts, bosses (per copy, 10-min respawn), destruction state (per copy),
parties, voice signalling relay, radio channels, moderation, analytics.

### 5.7 Voice (r2-13 §10, condensed)

- Config: `HEAR 35 m`, `CONNECT 45 m`, `DROP 60 m` (held 3 s), `MAX_PEERS 12`, `RADIO_CAP 8`,
  `OPUS_MAX 24000` bps.
- Server messages: `voice:enable {age16}`, `voice:disable`, `voice:ice` (the server mints **per-player**
  Cloudflare TURN credentials with `ttl: 43200` when voice is enabled, re-mints every 6 h, revokes on
  block/ban), `voice:signal {to, sdp?, candidate?}` (relayed only if both enabled, not blocked, not
  admin-muted, and within `DROP` or same radio channel), `radio:tune`, `radio:tx`, `voice:block`,
  `voice:report`. Our own ~100-line relay modelled on `colyseus/plugins/webrtc` (the plugin itself meshes
  everyone with no proximity gate, so it isn't used as-is). Transport `maxPayload` 16 KB for SDP.
- Client: one `RTCPeerConnection` per peer, `iceTransportPolicy: "relay"`, ICE list filtered to drop the
  STUN entry and any `:53` URLs, refreshed with `setConfiguration`; perfect negotiation (lower sessionId is
  polite), one sendrecv audio transceiver, `maxBitrate 24000`, Opus DTX on. 4 Hz proximity tick picks
  the 12 nearest within `CONNECT` + same-channel radio holders; senders gated with `replaceTrack`.
- Budget: Cloudflare bills only relay→client traffic; ~22.5 MB per listener-stream-hour at 50 kbps, so the
  free 1,000 GB/month covers thousands of player-hours. Check TURN analytics after launch.
- Audio: HRTF `PannerNode` (`linear`, ref 2, max 35) + proximity gain; radio chain (highpass 400 Hz,
  lowpass 2.8 kHz, soft clip, squelch on key-up/down).
- Safety: off by default; opt-in panel with 16+ checkbox and "never recorded"; push-to-talk V;
  listen-only if the mic is denied; mute, block (server-persisted), mute strangers (party only),
  panic mute-all, report; speaking rings from per-peer `AnalyserNode`. One-page
  `docs/risk-assessment.md` (UK OSA) written in M5.
- Fallback: `VoiceTransport` interface; LiveKit Cloud adapter stubbed (not deployed).

---

## 6. Game design (numbers in `docs/content.md`)

### 6.1 Bodies

| Body | Radius | Grade (film rule 1) | Sun | Enemies | Levels | Boss | Pads |
|---|---|---|---|---|---|---|---|
| Portus (hub) | 150 m | warm, clean, festive | high warm | none | — | — | portals |
| Arcadia | 500 m | green + turquoise, golden accent | golden, mid | voxel arcade creatures | 1–7 | Tidewrath (lake kaiju) | 12 |
| Hollowmere | 750 m | violet dusk, cyan-green accent | low violet | Hollow Court | 6–13 | Hollow King | 12 |
| Meridian | 1,000 m | red canyon + chrome, teal accent | hard white | Meridian Oversight | 12–20 | The Receiver (12 m mech) | 20 |

- **Portus:** a crater-bowl plaza ≤ 55 m across so everyone is in sight; portal ring to the three
  planets; shop; guide NPC; Hall of Firsts wall; notice board; onboarding path; music-reactive lights
  (film rule 9). Safe everywhere.
- **Every planet:** lakes (spherical-cap water), mountains (±15–25 m general relief, a few 60–120 m
  landmark peaks), fields, forests, wildlife, 8–12 POIs (enemy camps, ruins, the boss lair, egg
  sites), fast-travel pads at POIs (12 icosahedron / 20 Fibonacci), a main pad with the portal home
  and the mission guide. Each pad has a 12 m safe ring (D15). Pads are discovered by touching them (D2).
- **Terrain tech:** cube-sphere, 32×32-quad chunks at ~4 m spacing (~128 m), built in a Web Worker,
  skirts at seams, load ring 400–500 m, horizon culling; whole-planet proxy for orbit/sky views;
  shared deterministic height function with client/server parity tests (r2-11).
- **Teleport:** camera pulls out to ~2.6 R, cross-cut between planet proxies, pulls in at the target
  pad; the destination chunk ring prefetches meanwhile. Other planets hang in each sky.

### 6.2 Characters

4 starters on one skeleton (Hexwick, Brother Ash, Kappa, Unit 7) × 6 palettes; cosmetics attach to
sockets (head, back, face, belt). Anime-leaning toon shading (film rule 6): ramp + rim tinted by the
sky colour + a per-starter pattern mask. Rebirth lets you pick again.

### 6.3 Combat and weapons

All weapons from DECISIONS.md, 3 tiers each, plus fists; stats in `docs/content.md`. Tier 2 needs
level 6, tier 3 level 12 to equip. Each weapon has: model, third-person anims, muzzle/impact
VFX (light particles), SFX, crosshair, and a `destroys` flag (heavy/explosive/spell). Shield bubble
blocks projectiles; heal kit is a channelled heal; grenade arcs and explodes; sniper and bow scope.
Damage numbers optional (setting), colour-blind safe palette. Hit feedback: hit-marker, sound,
flash, light camera shake on big hits.

### 6.4 Enemies, wildlife, AI

Per-planet rosters, packs and camps from `docs/content.md`. Server-side FSM: idle → wander → notice
(cone + hearing) → chase → attack (telegraphed: 0.5 s light / 0.9 s heavy / 1.2 s boss) → leash
(40 m from home, return and regen). Steering-based movement on the heightfield with prop avoidance
(no navmesh on a sphere; D4). Woolbacks flee; Dusk Wolves hunt in packs of 3–5; one big neutral
beast per planet fights back when hit.

### 6.5 Bosses

Tidewrath, Hollow King, The Receiver per `docs/content.md`: co-op-only mechanics, no hints,
health = base × (2 players + 35% per extra), recomputed as players engage; breakable arena cover;
everyone who contributed gets their own loot; respawn 10 min after the kill, per copy; 2–3 voice
lines each with subtitles (ElevenLabs if credits allow, else subtitles + a processed ZzFX roar).

### 6.6 Death, loot, rebirth

0 HP = death everywhere. A pile of light-particles (film rule 4) holds every item and coin, labelled
with the owner's name and time; it never expires (1,000 per body cap). Anyone can loot (E → take all
or pick items). Death screen: killer, time alive, level; GitHub star/fork link; then character pick
→ rebirth in Portus at level 1 with the starter weapon. Kept: account, name, medals, Hall of Firsts,
discovered pads (D2). Lost: level, XP, items, coins, mission progress.

### 6.7 Progression and economy

XP curve (level 2 ≈ 1 min, level 5 ≈ 10 min, cap 20), HP/damage scaling, coin income, Portus shop
(potions, heal kits, grenades, shield bubbles, tier-1 weapons, radio 100 coins), sell-back rate — all
in `docs/content.md`. No ammo items: weapons have magazines and reloads (D5). No trading UI: drop items.

### 6.8 Missions, medals, Easter eggs

Guide NPC at each main pad: 3 missions (hunt / find / reach) that route through the boss lair area
and one egg area; per life; auto-complete with reward toast. ~20 medals (server-checked, toast, one
wearable as a title). 3 Easter eggs per planet, each with a rare item and hidden medal; first finder
engraved on the Hall of Firsts wall (global, once per secret).

### 6.9 Destruction

Breakable props (crates, barrels, fences, statues, pillars, camp walls, arena cover) have HP. The
server tracks broken props per copy and their rebuild time (3 min) and broadcasts
`broke {id, archetype, variant, impactDir}`. **Live fracture is too slow** (measured on the M1: 10–50 ms
for 16 pieces, up to 650 ms for 64, with triangulation failures at 64), so a Web Worker pre-fractures
each destructible archetype at load with `@dgreenheck/three-pinata` into 8–12 pieces × 2–3 fixed seeds,
transfers the geometry back, and caches it; the server picks the variant, so every client sees the same
shatter. On `broke`: hide the intact mesh, spawn pooled fragments, push them with custom cheap physics
(radial gravity, terrain-height collision, damping, no debris–debris contacts; D8), fade after ~10 s.
Budgets: ≤ 150 live fragments (oldest despawn early), ≤ 12 pieces per object, one material per fragment
(inner faces flagged by a vertex attribute, so 1 draw not 2). Destructible meshes must be manifold —
the Blender export script checks it. Rebuild with a light-particle re-materialise effect. Ground,
mountains and Portus buildings never break. Depend on the npm package (MIT); don't copy its unlicensed
`demo/` code.

### 6.10 Social

- **Player list (Tab):** players in your copy: name, level, starter, party, voice state; actions
  mute, block, invite to party (within 30 m), report; admin actions for admins.
- **Parties:** up to 4; compass markers; shared boss credit; travel together (§5.2).
- **Phrase wheel (G):** "Truce?", "Help!", "Follow me", "Boss here", "Thanks", "GG" as speech bubbles.
- **Radio:** item; B to talk; channel picker 1–9 in the inventory.
- **Screenshot (P / button):** capture the frame, stamp name, level, planet, FIRSTLIGHT mark and the URL;
  copy / download / Web Share (files) / "Share on X" intent with text + link.

### 6.11 Moderation and analytics

- Admin (claimed via token): kick, ban (account + IP hash), voice-mute, teleport to/bring player,
  spawn boss, announce banner. From the player list and `/admin`.
- `/admin`: reports, bans, players online per room, recent errors. `/stats`: sessions, playtime
  distribution, deaths, levels, backend/tier split, D1/D7 return. No third-party trackers.

### 6.12 Screens

- **Landing:** looping in-game flythrough video (recorded in M10; poster image until then), big Play,
  live "N players online", "Built in N hours by Claude Opus 5.5 and Codex. Open source.", GitHub
  Star/Fork buttons behind a `PUBLIC_REPO` flag (off until the owner makes the repo public).
- **Onboarding (~60 s, skippable):** move, look, jump, sprint, dodge, attack the training dummy,
  switch weapons, pick up, open the map, the phrase wheel, optional voice opt-in, walk through a
  portal. Star/fork link at the end.
- **Settings:** graphics tier + per-feature toggles, render scale, FOV, mouse sensitivity, invert Y,
  volumes (master/music/SFX/voice), voice (PTT/voice activation, mute strangers), colour-blind damage
  colours, key reference.
- **Design process:** Fable 5.1 and Opus 5.5 each produce the landing, HUD, menus, death screen and
  onboarding as static HTML/CSS mock-ups from the same brief; the builder picks the stronger one per
  screen (or merges) and implements it; Codex screenshots both for the record.

### 6.13 Photo mode and staged scenes

- **Photo mode (F9):** hide the HUD; free camera (WASD/mouse, Q/E down/up, Shift fast); FOV, DoF
  focus/aperture, exposure, planet-grade filter. Your body stays in the world (it can die).
- **Staged scenes** (`docs/staged-scenes.md` + admin command `stage <n>` that teleports you and
  sets the scene): 1 Portus crowd under the sky planets; 2 Arcadia vista with Tidewrath rising from
  the lake; 3 Hollowmere chapel at dusk vs the Hollow Court; 4 Meridian canyon co-op vs The Receiver;
  5 wild-west PvP with destruction and a loot pile. Each lists camera moves, who stands where, and how
  many browser windows to use.

### 6.14 Extras (M11, in order)

1. Photo mode is already core (F13). 2. Horses: bought in Portus, whistle (H) outside safe zones,
mount speed ~14 m/s, the whistle item drops on death. 3. Weather: rain and lightning storms per
planet (glass-box reference). 4. Day/night cycle. 5. More cosmetics and Easter eggs.

---

## 7. Graphics

### 7.1 Renderer

three.js r186 `WebGPURenderer` + TSL, automatic WebGL2 fallback (`?webgl` forces it). Node materials
only — no `ShaderMaterial`, `onBeforeCompile` or pmndrs postprocessing (unsupported) unless G1 fails.

- **Post:** `RenderPipeline` (not the deprecated `PostProcessing`). Low/Medium on either backend:
  `bloom` → `lut3D` (or `cdl` + `saturation`) → `fxaa`, with `outputColorTransform = false` and an explicit
  `renderOutput()`. Grain and vignette from `FilmNode`/`vignette`.
- **WebGPU-only extras** (High/Ultra, gated on `isWebGPUBackend`): `ao()` (GTAO; needs a normal MRT),
  `traa()` (MSAA off), `ssr()` on the nearest lake (normal + velocity MRT), compute grass and particles.
  On the fallback never build compute nodes (WebGL2 "compute" is 1-D transform feedback without atomics);
  use instanced-attribute grass and CPU-updated particle buffers instead. GTAO/TRAA/DoF aren't regression-
  tested upstream on WebGL2, so verify them on WebGPU only.
- **Shadows:** Low blob + baked vertex AO; Medium one `DirectionalLight` with `PCFShadowMap`; High/Ultra
  `SunLight` (2 cascades) or `CSMShadowNode`. `godrays()` only works with a shadow-casting
  `DirectionalLight`, not `SunLight` — use it in Portus and interiors where Medium-style lighting applies.
- **Draw-call discipline** (three #30560 per-draw UBO cost, worst on Metal; #33821 slow material init):
  share `NodeMaterial` instances; never create a unique `uniform()` per material (per-instance attributes
  or the instance-uniform pattern instead); `InstancedMesh` for vegetation and props, `BatchedMesh` for
  kit pieces; `object.static = true` on static meshes; budget ≤ ~300 draws on Medium, then measure.
- `KTX2Loader.detectSupport(renderer)` only after `await renderer.init()`.

Low/Medium must look and behave the same on both backends.

**Gate G1 (end of M1, ~2 h):** the test scene (§8 M1) holds ≥ 60 fps (p95 frame ≤ 16.7 ms) on Medium
on the owner's M1 after 3 min warm-up, and the WebGL2 fallback renders the same scene correctly.
If either fails after one optimisation pass: switch to `WebGLRenderer` + pmndrs `postprocessing`
(r2-15 §7 stack) before any game code depends on TSL, log the reason as a `D` entry, and tell the owner.

### 7.2 Look rules (r2-15 + R5 refs)

1. Two grades: muted UI/lobby/loading; saturated planets around one key hue + one accent (LUT per body).
2. Live-action light: warm sun key, cool hemisphere fill, fresnel rim; per-planet sun colour/elevation.
3. Depth from air: scattering sky, radial height fog with aerial perspective, sky planets, peaks rise
   above the haze.
4. Digital matter is light: spawns, deaths, loot piles, teleports and rebuilds are particle "corpuscles".
5. Emissive = gameplay: only interactive, dangerous or valuable things exceed the bloom threshold.
6. Anime-leaning avatars with readable silhouettes (Narrow One readability floor).
7. Deliberate grit: detail noise, wear, film grain.
8. Diegetic holograms for signs, markers and portals.
9. Music drives Portus lights.
10. Density from instanced kits dressed along sightlines.

**Bar:** close-ups at the level of Dan Greenheck's wizard-duel library and Leon Lin's glass box
(god rays, glowing particles, fog, water refraction) in Portus, boss lairs, interiors and near the
player; distant terrain simpler but lit and hazy.

### 7.3 Quality tiers

| | Low | Medium (M1 default) | High | Ultra |
|---|---|---|---|---|
| DPR cap × render scale | 1.0 × 0.67 | 1.25 × 0.85 | 1.5 × 1.0 | 2.0 × 1.0 |
| GPU frame target | ≤ 16 ms | ≤ 12 ms | ≤ 10 ms | ≤ 7 ms |
| Draw calls (incl. shadows) | ≤ 150 | ≤ 250 | ≤ 400 | ≤ 600 |
| Sky / fog | gradient dome + rim; radial fog | scattering 8/4 steps; height fog + aerial perspective | 16/8 | 16/8 + sky-planet atmospheres |
| Terrain | vertex colour + baked AO/sun | + 2-layer biplanar | 4 layers + normals | 4 layers 1024² |
| Shadows | blob + baked vertex AO | one 1024² map over 40 m | 2 cascades 1024² to 80 m | 2 × 2048² to 150 m |
| Grass | 25k (25 m) | 80k (40 m) | 200k (60 m, compute on WebGPU) | 500k (horizon) |
| Trees/rocks full mesh to | 15 m | 25 m | 40 m | 60 m |
| Water | colour + fresnel | + baked depth, foam | + ripples, cube map | + SSR on the nearest lake (WebGPU) |
| Post | bloom (4 mips) + tone map + LUT | + FXAA, vignette, grain | + GTAO half-res, TRAA (WebGPU) | + GTAO full, god rays |
| Particles (max live) | 2k | 5k | 15k | 30k |
| Full-detail avatars | 8 | 16 | 24 | 40 |

Auto-pick: `@pmndrs/detect-gpu` only to catch blocklisted/software/tier-0 → Low; then a ~2 s probe
rendering a fixed Portus view at Medium (GPU timer query where available, else rAF p50): p50 < 6 ms →
High (re-probe for Ultra), > 14 ms → Low. Runtime resolution ladder `[1, 0.79, 0.62, 0.5]`; at the
floor, drop a tier. Stored in `localStorage`; the settings menu overrides.

**Kill switches** (URL flags, also toggles in the F3 overlay): `?nobloom ?nofog ?nosky ?nograss
?notrees ?nowater ?noshadows ?noao ?noparticles ?nopost ?nochars ?nodestruct ?webgl ?tier=low|medium|high|ultra
?bench`. The F3 overlay shows fps, CPU/GPU ms, draw calls, triangles, backend, tier, chunk count,
entity count, ping.

### 7.4 Performance measurement

- `?bench`: a scripted 60 s camera path through the busiest scene (a Portus copy with 40 load-test bots +
  particles + voice idle; and an Arcadia boss fight; the bench client joins the load-test room through the
  admin-only flag below) reporting p50/p95/p99 frame time, draw calls and
  heap to the console and `window.__bench`. Codex runs it on the M1 in Chrome, plugged in, after 3
  min of warm-up (the Air throttles), and pastes the JSON into `docs/STATUS.md`.
- **Weak-laptop profile (F11):** Chrome on the M1 at a 1280×720 window, DevTools CPU 4× slowdown,
  `?tier=low`. Must hold ≥ 30 fps p50.
- Server: tick time p50/p95 per room, CPU, RSS, bytes sent per client per second, logged every 10 s
  to stdout and `/admin`.
- **Load-test bots stay private** ("no fake players, ever"): bots get JWTs from `POST /api/test/bot-token`,
  which exists only while `LOADTEST_SECRET` is set on Railway (unset it after M9); bots join only rooms
  created with `{loadtest: true}`, which the public matchmaker never picks, `/api/online` and `/stats`
  never count, and only admins (or the bench client with the secret) can enter. Bots bypass the guest
  sign-in rate limit through that route, not by loosening it.

---

## 8. Milestones

Hours are planning estimates from run start; lanes run in parallel. Each milestone ends with: tests
green, deployed, `docs/STATUS.md` updated, a short non-blocking check-in to the owner with a
screenshot. Significant merges get the three-model review (§9.4).

### M0 — Setup and skeleton (0:00–1:30)

- `caffeinate -dimsu` for the run; record the start time in STATUS.md.
- Repo, workspace, `docs/` (copy SPEC, DECISIONS, content, tech-facts), AGENTS.md, CONTRIBUTING.md,
  licences, `.gitignore` (incl. `assets-private/`, `.env*`).
- Accounts and infra per §10 (Codex handles dashboards in parallel).
- Hello-world deploys: client on Vercel at `firstlight.one4all.dev`; server `/healthz` on Railway at
  `api.firstlight.one4all.dev`; Worker serving a test asset with CORS; a WebSocket round-trip.
- **Done when:** all three URLs respond over HTTPS and a browser on the client domain opens a
  WebSocket to the API.

### M1 — Renderer gate G1 (0:30–2:30)

- Test scene on Arcadia: streamed chunk terrain with smooth normals, scattering sky + height fog,
  80k grass, instanced trees/rocks, one lake, bloom + tone map + LUT, 40 placeholder animated
  characters, 2k particles, F3 overlay, kill switches, tier switch, `?bench`.
- Run `?bench` on the M1 (Codex) on WebGPU and `?webgl`.
- **Done when:** G1 decided and logged (§7.1).

### M2 — Walking multiplayer world (2:00–5:00)

- All four bodies with terrain, POIs placeholders, pads, safe rings, portals + teleport transition,
  sky planets. Player controller, camera, input, swimming, fall damage.
- Colyseus rooms, matchmaking with copies and caps, interest management, prediction/interpolation.
- Guest auth (no email yet) so joins are authenticated from day one.
- **Done when:** two browsers see each other walk, jump and teleport between planets on production.
  Check-in 1 to the owner (screenshot of the test scene + two players).

### M3 — Combat core (4:00–8:00)

- Fists, Pocket Carbine, Hexquill, Sunbrand, bo staff first; HP, damage, hit feedback, death, piles,
  rebirth, character pick, inventory/hotbar, pickups, level gates.
- Arcadia enemies + Woolbacks + Dusk Wolves with spawns near players.
- XP, levels, coins, Portus shop (basic).
- PvP + friendly fire + safe zones; logout rules; combat tag; graceful deploy restarts.
- **Done when:** a player can level to 3 on Arcadia, die to another player, and loot their own pile
  after rebirth (unit + bot + manual check).

### M4 — Accounts and persistence (parallel, 3:00–7:00)

- SQLite schema, autosave, Better Auth anonymous + emailOTP + JWT, `onLinkAccount` migration,
  second-browser sign-in, one live session per character, names + filter, admin claim, rate limits.
- Resend domain verified; a real OTP email is received in the disposable test inbox (D6) — never the
  owner's inbox.
- **Done when:** E2E T5 passes.

### M5 — Voice (parallel, 5:00–9:00)

- Full §5.7: opt-in panel, PTT, proximity mesh, TURN relay-only, spatial audio, radio item + channels
  + filter, phrase wheel, mute/block/strangers/panic/report, speaking rings, risk-assessment doc.
- **Done when:** E2E T4 passes between two browser profiles on the M1 (relay-only forces TURN, so
  this exercises the real path).

### M6 — Content (7:00–14:00)

- All weapons (3 tiers), shield, heal, grenade, radio; all three planets' enemies, wildlife, neutral
  beasts, camps; missions + guide NPCs; medals; Easter eggs + Hall of Firsts.
- Bosses in order: Tidewrath → Hollow King → The Receiver.
- Destruction (§6.9).
- **Done when:** E2E T2 and T6 pass; every mission, egg and medal has a server test.

### M7 — Look and assets (lane from 1:00, polish 10:00–15:00)

- Concept art (Codex image generation) for the 4 starters, 3 bosses, enemy families, Portus, key
  weapons → `assets-src/concept/`, CC BY 4.0, posted to the owner in a check-in (non-blocking).
- Blender lane on the M1 (headless scripts): starters from CC0 rigged bases restyled to the concept
  art, palettes, cosmetics, weapons, bosses (Receiver mech, Hollow King, Tidewrath), Hollow Court and
  Meridian Oversight units. Arcadia voxel creatures generated procedurally in code.
- Biome kits, palette atlases, LUTs, VFX, per-planet music, SFX, boss lines.
- Full quality tiers, settings menu, loading/streaming, landing + onboarding (Fable vs Opus designs).
- **Done when:** Codex visual check of each body against the look rules passes, and the landing and
  onboarding are implemented from the chosen designs.

### M8 — Social and operations (10:00–14:00)

- Parties, player list actions, invites, compass markers, moderation tools, `/admin`, `/stats`,
  analytics events, queue + caps, screenshot share.
- **Done when:** E2E T7 passes and `/stats` shows the run's test sessions.

### M9 — Hardening (14:00–18:00)

- Load test F2 (40 bots on one planet copy, then 2 copies × 4 bodies if CPU allows) → record tick
  p95, CPU, RSS, egress per client → estimate monthly cost at 10/50 concurrent players.
- Perf pass to F10/F11 on the M1.
- Full E2E suite T1–T8 (Codex; Playwright fallback per §9.3).
- Three-model review of the whole codebase; fix blockers.
- Security pass: auth flows, rate limits, admin routes, input validation, no secrets in the bundle.

### M10 — Video-ready (17:00–20:00)

- Photo mode, `stage <n>` command, `docs/staged-scenes.md`, landing flythrough video recorded
  in-game (Codex screen-records the photo-mode path or the client renders frames via `?record`).
- Final report to the owner (§12).

### M11 — Extras (after the finish line, until stopped)

Horses → weather → day/night → cosmetics and more Easter eggs. Each ships behind a flag, deployed
only when its tests pass.

**Priority when time is tight** (from R3 Q1): never cut walk, fight, loot, die, voice and the
Tidewrath fight. If behind: drop Ultra extras first, then Easter eggs beyond one per planet, then the
Hollowmere/Meridian bosses' second phases, then the radio — but the finish line still needs the radio
(F6), so it is the last to go.

---

## 9. How the work gets done

### 9.1 Roles

| Who | Model / tool | Does |
|---|---|---|
| Builder (this thread) | Claude Opus 5.5 | Architecture, `packages/shared`, netcode, integration, merges, decisions, check-ins; writes the critical path itself |
| Lane agents | Claude Opus 5.5 sub-agents (Agent tool, `isolation: "worktree"`) | Bounded modules with an interface contract: rendering features, terrain worker, voice, auth/persistence, UI screens, AI/bosses, Blender/asset pipeline, audio, load-test bots |
| Side agent | Claude Fable 5.1 (`delegate_task`, provider `claudeAgent`, effort max) | Competing UI/landing designs, character and boss sheets, lore/medal/mission text, an independent second implementation when a design choice is uncertain |
| Codex | `gpt-6.1-sol`, Fast tier, via `delegate_task` (provider `codex`) | All UI/E2E tests and visual checks (computer use on the owner's Chrome), dashboard setup (Resend, Cloudflare, Railway alerts), concept-art image generation, perf benchmarks on the M1, code review (high effort) |
| Reviewers | Codex Sol 6.1 high + Opus 5.5 + Sonnet 5.5 in parallel | Review before significant merges and before the final sign-off. They report; the builder decides and fixes |

At most ~6 lane agents at once; each owns a disjoint set of paths (declared in its brief) to avoid
merge conflicts; `packages/shared` changes go through the builder.

### 9.2 Lane brief template

Every sub-agent brief contains: goal; files/paths it owns; interfaces it must implement or consume
(exact TS types from `packages/shared`); acceptance checks (commands + expected output); ports to use;
"do not touch" list; the IP line; "no secrets in code"; "report: what changed, how verified, open
issues". The builder reviews the diff before merging.

### 9.3 Testing

- **Unit (vitest):** height-function client/server parity (10k random dirs, |Δ| < 1 mm), movement
  validation, damage/XP/coin math, inventory, pile rules, logout timers, matchmaking caps, medal and
  mission checks, slur filter.
- **Server integration:** in-process Colyseus + SDK bot clients: join, move, fight, die, loot, travel,
  party travel, caps/queue, graceful restart.
- **E2E cards** (`docs/tests/e2e-cards.md`, exact steps + expected results + screenshot names), run by
  Codex computer use (D23: now T3 Code's built-in browser): T1 landing→play < 30 s, T2 fight PvE/PvP, T3 death + own pile, T4 voice + radio,
  T5 email sign-in + second browser, T6 2-player boss kill (two windows; an admin `stage` command may
  pre-place the players), T7 screenshot share, T8 photo mode.
- **When Codex control breaks:** retry up to 3 times ~10 min apart (keep building meanwhile); then run
  the Playwright fallback spec for repeatable flows (T1, T3, T5, T7 and a two-context voice
  signalling check); look-and-feel checks wait for Codex. Codex may use its AppleScript fallback,
  Chrome only.
- **Load:** `tools/bots` (§7.4, F2).

### 9.4 Review

Before merging significant work (a lane's first merge, netcode, auth, voice, anything touching
money/limits) and at M9: dispatch the three reviewers in parallel with the diff range and the
relevant spec sections. Save reports to `docs/reviews/<date>-<topic>-<model>.md`. Fix blockers before
deploying. PRs are linked to this thread with `link_pull_request`.

### 9.5 Deploys

- **Client:** Vercel project `playfirstlight` (root `apps/client`), Git integration on `main`, or
  `vercel --prod` from local builds if Git integration misbehaves. Doesn't disconnect anyone.
- **Assets:** `npx wrangler@4.149.0 deploy` from `apps/assets-worker`. Content lives under
  `/v/<buildId>/…`; **every deploy also ships the previous build's directory** (a deploy replaces the
  whole asset set, so mid-session lazy loads would 404). Watch the 20,000-file and 25 MiB-per-file caps.
  Never enable `run_worker_first` or Workers Caching (they turn free asset requests into metered ones).
- **Server:** Railway service `game-server` from `main` (`apps/server`), built from `apps/server/Dockerfile` (`RAILWAY_DOCKERFILE_PATH`; Railpack is not used), Node 24. **Each deploy
  disconnects everyone** (one replica because of the volume), so server deploys are batched (D9): during
  the run at most about one every 30 minutes unless a fix is urgent; after launch only when needed.
- **Smoke test after every production deploy:** `/healthz`, `/api/play` with a bot JWT, one bot
  join/leave, `x-vercel-cache: MISS` on `/api/auth/token`.

---

## 10. Setup runbook (M0)

Commands are verified against the current CLIs (`docs/tech-facts.md` §7–§9).

| # | Step | Who / how |
|---|---|---|
| 1 | `caffeinate -dimsu &` (record PID; kill at the end) | Builder |
| 2 | `gh repo create RostyslavDzhohola/firstlight --private`; push the skeleton | Builder |
| 3 | `vercel project add playfirstlight && vercel link --yes --project playfirstlight`; `vercel domains add firstlight.one4all.dev playfirstlight`; `vercel.json` per tech-facts §8 (`routes` proxy for `/api/auth/(.*)` with the `x-origin-secret` transform, `x-vercel-enable-rewrite-caching: 0`, redirect `playfirstlight.vercel.app` → canonical); env vars (§10.1) | Builder (Vercel CLI) |
| 4 | Railway: `railway init --name firstlight`; `railway add --service game-server`; `railway scale --service game-server us-east=1` (US East = `us-east4`) **before** the volume; `railway volume --service game-server add --mount-path /data`; variables via `railway variable set … --skip-deploys` (secrets via `--stdin`); `railway domain api.firstlight.one4all.dev --service game-server --port 2567` → add its CNAME and TXT with `vercel dns add one4all.dev …`; `railway usage limit set --target workspace --soft 25` (email alert only, no hard limit). No `railway.json` (deprecated) | Builder (Railway CLI) |
| 5 | Railway dashboard: Replica Limits **2 vCPU / 2 GB** (dashboard-only); confirm the plan is Hobby | Codex (computer use) |
| 6 | Resend: check the plan and domain count (free = 100 emails/day, 3 domains); add `firstlight.one4all.dev` (us-east-1) in the dashboard; builder adds DKIM TXT `resend._domainkey.firstlight`, MX + SPF TXT on `send.firstlight`, DMARC TXT `_dmarc.firstlight` with `vercel dns add`; verify; create a **sending-only key restricted to that domain** for Railway | Codex (dashboard) + builder (DNS, env) |
| 7 | Cloudflare: find or create the account (owner clicks the verification email if new — the only expected owner action); register the `workers.dev` subdomain; create an "Edit Cloudflare Workers" API token + account id for wrangler; create a Realtime TURN key (`uid` + `key`) | Codex (dashboard) + builder |
| 8 | Generate `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `ADMIN_CLAIM_TOKEN`, `ORIGIN_SECRET` into `~/.config/firstlight/.env`; push to Railway (`--stdin`) and Vercel without printing | Builder |
| 9 | Disposable test inbox for E2E email tests (D6) | Builder |

If step 7 waits on the owner's click, voice and assets proceed locally (local TURN-less tests, assets
served by Vite); the owner is pinged once (non-blocking) and the step finishes when the click arrives.
If Resend's free plan has no free domain slot or the daily cap would block testing, that is a spending
or other-project stop (§11): ask.

### 10.1 Environment variables

| Where | Names | Notes |
|---|---|---|
| Railway `game-server` | `NODE_ENV=production`, `PORT=2567`, `RAILPACK_NODE_VERSION=24`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://firstlight.one4all.dev`, `CLIENT_ORIGIN=https://firstlight.one4all.dev`, `AUTH_DB_PATH=/data/auth.db`, `GAME_DB_PATH=/data/game.db`, `RESEND_API_KEY` (sending-only, domain-scoped), `EMAIL_FROM=FIRSTLIGHT <login@firstlight.one4all.dev>`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `ADMIN_CLAIM_TOKEN`, `ORIGIN_SECRET`, `MAX_COPIES_PER_BODY=2`, `MAX_CLIENTS=40`, `SOLO_FILL_LIMIT=36`, `OTP_DAILY_BUDGET=80`, `LOADTEST_SECRET` (set only during load tests) | Secrets via `--stdin`, never logged. Never set `JWT_SECRET` |
| Vercel `playfirstlight` | `ORIGIN_SECRET` (for the `routes` header transform), `VITE_API_URL=https://api.firstlight.one4all.dev`, `VITE_ASSET_BASE=https://firstlight-assets.<acct>.workers.dev/v/<buildId>`, `VITE_PUBLIC_REPO=false` | |
| Local `~/.config/firstlight/.env` | all secrets above + `ELEVENLABS_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | chmod 600 |

---

## 11. Stop conditions and escalation

Stop and ask the owner only for:

1. Spending money beyond current plans (incl. a Railway plan upgrade, a paid Cloudflare/Resend/Vercel tier).
2. Anything public under the owner's name: posts, making the repo public, enabling the GitHub buttons.
3. Touching the owner's other projects or domains beyond adding FIRSTLIGHT DNS records to one4all.dev.
4. A clear copyright or trademark red line.

Everything else: decide, log, continue. If blocked on an external step, ping once and work on
something else. If a service is down, build against a local stand-in and retry later.

---

## 12. Final report to the owner

Live URL; admin claim link location; what shipped vs the finish line (each F-check with evidence);
measured numbers (fps by tier/backend on the M1, load time, load-test tick/CPU/RAM/egress and a
monthly cost estimate); E2E results with screenshots; review summary; open issues; what's in M11
progress; how to make the repo public and switch on the GitHub buttons; the staged-scenes guide.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| WebGPURenderer is still "experimental": per-draw UBO cost worst on Metal (#30560), slow material init (#33821), post-pass precompile broken (#34681) | Gate G1 with a pre-agreed fallback; draw/material discipline (§7.1); warm-up with real frames + a zero-new-builds test; kill switches |
| Colyseus defaults: auth bypass via `@colyseus/auth`, CORS reflects any origin, no cap on copies, `joinById` rejects full rooms | `/api/play` + `reserveSeatFor`, `onAuth` override, CORS allow-list, `exposedMethods = ["reconnect"]`, party headroom (§5.1–5.2) |
| StateView encode cost at 40 players | Measure in M9; fallback to a shared player map with views only for NPCs/piles/props |
| Better Auth edges: id changes on save, stale-cookie sign-in (#11533), anonymous rate limit, silent OTP send failures, email in default JWT | §5.4 rules + tests for each |
| Safari 7-day cap on cookies set by the CNAME'd API host | Keep the Vercel `/api/auth` proxy |
| Every Railway deploy disconnects everyone | Graceful shutdown + auto-rejoin; batched server deploys (D9) |
| Codex computer use flakes | Retries + Playwright fallback (§9.3); keep building meanwhile |
| Voice NAT/TURN; 48 h credential cap | Relay-only, per-player 12 h credentials refreshed via `setConfiguration`; LiveKit adapter interface ready |
| Resend free plan: 100 emails/day, 3 domains (shared with the owner's other uses) | Our own OTP budget (≤ 80/day); "saving is busy" UI; upgrade is a spending stop |
| Railway alert is workspace-wide (other projects ran $3.65 last month) | $25 soft alert leaves ~$20 headroom for FIRSTLIGHT; check `railway usage` after the load test |
| Node 26 becomes "lts" on 28 Oct; TypeScript 7 has no compiler API | Pin Node 24; TS 7 for typecheck only; schema builders, no decorators |
| ElevenLabs credits (794 now, shared with another app) | 9 boss lines ≈ 590 credits incl. voice design; subtitles + processed SFX if credits run out |
| Live fracture too slow (10–650 ms measured) | Pre-fracture in a worker at load; pooled fragments; manifold meshes |
| DNS/verification delays (Resend, custom domains) | Start in M0; `*.vercel.app` / `*.up.railway.app` work meanwhile |
| Egress cost | Interest management, quantised messages; measured in M9 with a monthly estimate |
| Content volume vs time | Priority order (§8); data-driven content in `packages/shared/content` |
| IP | Name checklist in `docs/content.md` §10; "Hollow King" kept by owner decision (fallback name ready, D16); no third-party names, rips or logos |
| Cheating | Server authority for damage/loot; movement validation; anomaly log |
| UK OSA / COPPA exposure from voice | Opt-in, 16+ checkbox, report/block, no recording, risk-assessment doc |
| Unverified until day 1: client IP through the proxy, `Origin` surviving the rewrite, Safari WebGPU on the owner's macOS | M0 checks listed in `docs/tech-facts.md` "Risks" item 18 |

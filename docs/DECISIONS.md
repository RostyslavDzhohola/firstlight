# FIRSTLIGHT decision log

Every decision the owner made during planning (grilling rounds 1–4, 9–11 Oct 2026), plus
decisions the builder makes during the run. Later entries override earlier ones. During the
run, append new decisions at the bottom under "Run decisions" with the time and the reason.

Source tags: R1–R4 = grilling round, Q = question number in that round.

## Product

- **What it is:** an original-IP multiplayer game in the browser: a persistent multi-planet open world. Free,
  open source, zero monetization. Desktop browsers only; phones get a "play on your computer"
  page with a copy-link button. (initial brief, R1 Q16)
- **Name:** FIRSTLIGHT. Hub planet: Portus. Planets: Arcadia, Hollowmere, Meridian. (R1 Q1, R2 Q1)
- **Purpose:** the owner records a video for X (maybe HN, web-game sites). The experiment is
  "how far can Opus 5.5 + Codex go". Success signal = people play long and come back. (initial brief)
- **Ambition:** maximum. One continuous autonomous run (~20 h, keep going until the finish line).
  Opus 5.5 does the bulk; Fable 5.1 on the side; Codex for tests, review, dashboards, concept art. (R2, R3 Q1)
- **Downloads:** none to install. Everything runs from the link. Large in-browser downloads are
  fine if they're worth it (streamed after you're playing). (R4 Q12 notes)

## Hosting, accounts, domains

- **Client:** Vercel Hobby (account already on Hobby). Address `firstlight.one4all.dev`
  (owner owns one4all.dev, registered via Vercel, renews 26 Jun 2027). `playfirstlight.vercel.app`
  also kept. (R3 Q5, R4 Q1)
- **Big assets:** free Cloudflare Workers static assets on `*.workers.dev`, so Vercel only serves
  ~2 MB per visit. (R3 Q5)
- **Game server:** Railway (owner is on the $5 Hobby plan). Colyseus 0.18 + Express + Better Auth,
  SQLite on a Railway volume. Address `api.firstlight.one4all.dev`. (R2, R4 Q1, Q17)
- **Cost guard (R4 Q17 = a):** no account-wide Railway hard limit (it would take the owner's
  other projects offline). Instead: 40 players per planet copy, at most 2 copies per planet
  (320 online max), then a short queue on the landing page; Railway replica limit on the game
  service of 2 vCPU / 2 GB (≤ $60/month compute at Railway's $20/vCPU and $10/GB prices); a Railway
  email alert at $25 (Railway's alert covers the whole workspace; the owner's other projects ran $3.65
  last month); measure egress during the load test and report it.
- **Sign-in:** Better Auth inside the game server. Guest first (anonymous plugin); after the first
  level-up the game offers "save your character" with a 6-digit email code via the owner's Resend
  account. No Google, no Clerk. (R2 Q11)
- **Email sender:** `FIRSTLIGHT <login@firstlight.one4all.dev>`. Never hiredclaw.com. DNS records
  added via `vercel dns`; Codex adds the domain in the Resend dashboard. (R3 Q6, R4 Q1)
- **Repo:** `firstlight` under GitHub RostyslavDzhohola. Private during the sprint; public at launch
  only with the owner's go-ahead. Code MIT; own art CC BY 4.0; ElevenLabs outputs never in the repo.
  Contributor guides for AI agents (`AGENTS.md`, `CONTRIBUTING.md`). No CI. (R3 Q7, R1 Q18, R4 defaults)
- **Cloudflare:** a free account for voice relay (TURN) and asset hosting. If the owner has none,
  Codex signs up with the owner's email and the owner clicks one verification link. (R4 Q2)
- **Spending stops:** stop and ask before spending money beyond current plans (including a Railway
  plan upgrade). (R4 Q2)

## Graphics

- **Renderer (R4 Q12 = b):** three.js WebGPURenderer + TSL, automatic WebGL2 fallback.
  WebGPU-only extras on High/Ultra (compute grass and particles, GTAO, lake reflections, TRAA).
  May borrow techniques from MIT-licensed Tidewater for Ultra sky/water.
- **Renderer gate:** in the first ~2 hours, a test scene must hold 60 fps on Medium on the owner's
  MacBook Air M1 (measured after warm-up; it throttles) and the WebGL2 fallback must work. If it
  fails, switch to WebGLRenderer + pmndrs postprocessing before game code depends on it, and log why.
- **Look (R3 Q2):** the RPO film crew's rules: muted menus, saturated planets; live-action lighting;
  haze for depth; digital things (spawns, deaths, loot) made of light particles; only what matters
  glows; avatars lean anime. Per-planet colour grade, real sky with other planets visible, textured
  mountains, wind-blown grass and forests, lakes, particles.
- **Bar (R5 refs):** close-up quality like Dan Greenheck's wizard-duel library and Leon Lin's
  glass-box diorama (Opus 5.5). Full detail near the player, Portus, boss lairs and interiors;
  distant terrain simpler but lit and hazy.
- **Quality tiers:** Low / Medium / High / Ultra, auto-picked by a ~2 s benchmark, changeable in an
  in-game graphics menu. Low keeps glow and colour grade. M1 Air lands on Medium.
- **Load:** playable within ~20 s of the first visit with < ~25 MB downloaded; everything else
  (Ultra textures, other planets) streams in the background; repeat visits from cache. Shader
  warm-up hidden behind the loading screen.

## World

- **Layout (R1 Q2, R2 Q2, R3 Q3):** separate safe hub planet Portus (150 m radius). Three planets,
  all gates open from minute one:

  | Planet | Radius | Look | Enemies | Levels | Boss |
  |---|---|---|---|---|---|
  | Arcadia | 500 m | green and turquoise, golden sun | voxel arcade creatures | ~1–7 | Tidewrath, a kaiju that rises from the big lake |
  | Hollowmere | 750 m | violet dusk, misty marshes, ruined chapels | Hollow Court: skeletons and ghouls | ~6–13 | the Hollow King |
  | Meridian | 1,000 m | red canyons, salt lakes, chrome towers | Meridian Oversight: corporate drones and enforcers | ~12–20 | The Receiver, a 12 m mech |

- **Every planet:** lakes, mountains, fields, forests, wildlife (Woolbacks to farm, Dusk Wolves in
  packs, big neutral beasts) and enemy camps. Procedural chunked cube-sphere terrain; fast-travel
  pads (about 12 / 12 / 20); radius is one config number, retuned after M1 testing.
- **One shared world (R4 Q3 rev):** the share link is just the game address. Everyone plays in the
  same world; a planet opens a second copy only when full; new arrivals fill the fullest copy.
  Player cap 40 per planet copy (R4 Q15), max 2 copies (R4 Q17).

## Rules

- **PvP (R2 Q3):** anywhere outside safe zones, any level vs any level, no wanted system, no police,
  no level brackets. Friendly fire on, even inside a party. Safe zones: all of Portus and a ring
  around every fast-travel pad, marked on the ground and with a "SAFE ZONE" sign.
- **Death (R2 Q4, R4 Q4–Q5):** 0 HP = dead, everywhere. No downed state (R2 Q7). Everything carried
  drops into a pile that stays forever; anyone can loot it, including the reborn owner. Safety cap:
  1,000 piles per planet, oldest removed. No bank.
  - **Kept:** account, name, medals (achievements), Hall of Firsts entries.
  - **Lost:** level, XP, every item, every coin.
  - **Rebirth:** in Portus at level 1 with a starter weapon; pick any starter character again.
- **Weapon level gates:** tier 2 needs level 6, tier 3 needs level 12 to equip. Anyone can pick up
  anything (and sell it). (R2 Q4, R3)
- **Logout (R2 Q6):** instant in safe zones. Elsewhere a 30 s countdown (the book's rule); moving or
  taking damage cancels it; can't start within 10 s of combat; hint + compass to nearest safe zone.
  Closing the tab outside a safe zone leaves the body in the world for 30 s. On return you appear
  where you left with 5 s of protection (can't attack during it). Server autosaves; no save button.
- **Alt-tab:** the shared world can't pause. Play goes fullscreen + pointer lock; Esc shows "click to
  resume". "If they accidentally die, they die." (R1 Q6)
- **Bosses (R1 Q7, R2 Q7, R4 Q6):** co-op only; too strong for one player; the game gives no hints.
  Always available; respawn 10 min after a kill, separately in each world copy. Health tuned for 2
  players +35% per extra. Everyone who helped gets their own loot.
- **Missions (R4 Q6):** a guide NPC at each planet's main pad offers 3 short missions (hunt, find,
  reach) paying XP and coins; they steer players toward the boss lair and one Easter egg area.
- **Achievements and Easter eggs (R2 Q5):** ~20 medals (progress, feats, survival, jokes), one
  wearable as a title. 3 secrets per planet (e.g. shrine behind a waterfall, riddle chest, odd-route
  room) each giving a rare item + hidden medal; first finder engraved on the Hall of Firsts in Portus.
- **Progression (R1 Q8):** our own design, RuneScape only as inspiration. Fast early: level 2 in
  ~1 min, level 5 in ~10 min. Level cap 20. Coins from kills, missions and selling; Portus shop.
- **Parties (R4 Q3 rev):** up to 4, formed in-game (Tab, pick someone nearby, invite). Members show on
  each other's compass, share boss credit, and always travel into the same world copy.
- **Destruction (R4 Q16 = a, core):** crates, barrels, fences, statues, pillars, enemy camp walls and
  boss-arena cover shatter under explosions, heavy weapons and spells. Ground, mountains and Portus
  buildings never break. Server decides what broke; clients shatter locally (three-piñata, MIT);
  debris fades after ~10 s; objects rebuild after a few minutes.
- **Empty world (R4 Q7 = a):** no fake players, ever. Bots only for private load tests.

## Characters, weapons, content

- **Starters (R2 Q8):** same skeleton, looks and starting weapon only, no stat differences:
  Hexwick (young wizard, Hexquill wand), Brother Ash (hooded desert monk-knight, Sunbrand energy
  blade), Kappa (turtle-shell ninja from Japanese folklore, straw hat, bo staff), Unit 7 (white-armour
  trooper, Pocket Carbine). 4 starters × 6 colour palettes, picked at creation. Cosmetics on top.
- **Weapons (R3, all genres mixed, 3 tiers each):**

  | Type | Weapons |
  |---|---|
  | Melee | Sunbrand energy blade, bo staff, axe, hammer |
  | Magic | wand (Hexquill), fire staff, chain-lightning caster |
  | Ranged | blaster, shotgun, longbow (arcing arrows), sniper (scope), rocket launcher |
  | Support | grenade, heal kit, shield bubble |
  | Item | radio |

- **IP line (R2 Q9, Dota rule):** never the owner's names or near-misses (no "Jedi", "lightsaber",
  "Hogwarts", "Ninja Turtles", "-zilla", no one-letter variants); never ripped models, sounds, music
  or logos; everything made from scratch. Silhouettes, archetypes, functions and feel may be close.
  If a takedown comes, rename and redraw.
- **Art pipeline (R1 Q13):** Codex concept art (owner's subscription is fine) → Blender on the
  owner's Mac driven by scripts (CC0 rigged bases restyled; bosses/weapons modelled to the concept
  art; planets generated in code). The Mac is available any time for Blender and perf tests.

## Social, voice, safety

- **Voice (R2 Q10, R3 Q4):** proximity voice: full volume within 2 m, silent at 35 m, directional.
  P2P mesh to the 12 nearest players, relay-only through Cloudflare TURN (players never see each
  other's IPs; 1,000 GB/month free). LiveKit Cloud fallback behind a transport interface.
  Off by default; enabling asks for the mic and an "I'm 16 or older" checkbox; push-to-talk V;
  mute/block anyone; "mute strangers" switch; speaking icon; never recorded.
- **Radio:** 100 coins in Portus; channels 1–9; same channel + same planet hear each other at any
  distance with a crackly filter; max 8 per channel; drops on death. Talk on B.
- **Phrase wheel (R2 Q10):** G opens 6 fixed phrases as speech bubbles: "Truce?", "Help!",
  "Follow me", "Boss here", "Thanks", "GG".
- **No text chat.** Names unique, 3–16 characters, slur-filtered. (R4 defaults)
- **Moderation (R4 Q9):** the owner's account is admin: kick, ban (account + network address), mute
  anyone's voice, teleport, spawn a boss, announce. Players report from the player list (who, when,
  where; never audio). Private `/admin` page with reports and stats.
- **Sharing (R1 Q17, R2):** screenshot key/button stamps name + level and opens a post on X with the
  link. Leaderboard, death card and clip recording are cut.
- **Analytics (R1 Q18):** our own server only: sessions, playtime, deaths, levels, D1/D7 return.
  Private `/stats`. No third-party trackers.

## Screens

- **Landing (R4 Q8):** looping in-game flythrough backdrop, big Play button, live players-online
  count, one line "Built in N hours by Claude Opus 5.5 and Codex. Open source.", GitHub Star/Fork
  buttons that go live when the repo is public.
- **Onboarding (R1 Q18):** ~60 s interactive tutorial in Portus (move, fight, weapons, buttons).
  GitHub star/fork links at the end of onboarding and on the death screen.
- **Design process (R1 Q18):** Fable 5.1 and Opus 5.5 each design the landing page, menus, onboarding
  and transitions; the builder picks the better one.

## Defaults accepted (R4)

- **Controls:** WASD move, mouse aim, left click attack; right click aims down sights (blocks for
  blades, charges for bows); Shift sprint; Space jump; dodge-roll (see run decision D1); 1–4 weapons;
  E pick up; Tab player list (mute, block, invite, party, report); V push-to-talk; B radio; G phrase
  wheel; M map; I inventory; Esc menu. No flying (R1 Q9).
- **Camera:** third person over the shoulder, FOV slider; sniper and bow zoom into a scope.
- **Inventory:** 4 hotbar + 16 backpack slots, no weight limit; trade by dropping items.
- **Movement:** swimming in lakes (slower, no attacks); fall damage from high cliffs; no climbing.
- **Audio:** free licensed music per planet and free sound effects (ZzFX, CC0). ElevenLabs only for a
  few boss lines now (794 credits until 16 Oct 2026 14:53), more after the reset.
- **Settings:** graphics level, resolution, FOV, mouse sensitivity, volumes, voice. Boss lines get
  subtitles; damage colours are colour-blind safe.
- **Server:** US East (Virginia), 20 updates per second.

## Extras after the core (R4 Q10, in order)

1. Photo mode (hide HUD, free camera)
2. Horses (buy in Portus, whistle outside safe zones, drop on death)
3. Weather (rain, lightning storms; aim for the glass box's look)
4. Day/night cycle (until then, each planet has a fixed best-looking time of day)
5. More cosmetics and Easter eggs

## Process

- **Run rules (R4 Q2):** never stop to ask; decide and log here. Stop only for: spending beyond
  current plans; anything public under the owner's name (posts, making the repo public); touching the
  owner's other projects or domains beyond adding FIRSTLIGHT records; a clear copyright/trademark red
  line. Non-blocking check-ins with screenshots at milestones. Continuous deploys to the live address
  (unshared until the owner shares it). Mac stays awake (`caffeinate`).
- **Testing (R4 Q13):** Codex gpt-6.1-sol (fast) computer use runs every UI/E2E test. When its control
  breaks, retry up to 3 times ~10 min apart, then run that check with Playwright (headless). Look-and-
  feel checks wait for Codex. Codex may use its AppleScript fallback, on Chrome only (R4 Q14).
- **Review:** Codex Sol 6.1 (high) + Opus 5.5 + Sonnet 5.5 in parallel before merges and deploys of
  significant work. The reviewers report; the builder decides and fixes.
- **Finish line (R4 Q11, as amended by Q15):**
  - live at the address; 40 test players on one planet don't break the server;
  - tests pass: landing → playing in < 30 s; fighting; death then looting your own pile; voice between
    two browsers plus the radio; email sign-in then the same character in a second browser; a 2-player
    boss kill; the screenshot share;
  - ≥ 60 fps on Medium on the M1 in the busiest scene; Low playable on a weak-laptop profile;
  - the three-model review signs off;
  - photo mode works, plus 5 staged scenes ready to record.

## Run decisions

Append here during the build: `- **D<n> (<time>):** <decision>. Why: <reason>.`

- **D1 (planning):** dodge-roll moves from Ctrl to C. Why: Ctrl+W (dodge while moving forward) closes
  the browser tab, and pages can't block it outside Chrome's fullscreen keyboard lock.
- **D2 (planning):** fast-travel pads are discovered by touching them, and discoveries belong to the
  account (kept on death). Why: big planets need pads, all-pads-from-start shrinks the world, and
  re-walking 20 pads after every death punishes exploration rather than risk.
- **D3 (planning):** player movement is client-predicted with server validation (speed, ground height
  ± 0.3 m, colliders) and snap-back; damage, loot and all state changes stay server-authoritative.
  Why: full server-side input simulation on a sphere costs days; validation stops speed/teleport cheats.
- **D4 (planning):** no navmesh; enemies use steering on the heightfield with prop avoidance. Why:
  navmesh tools assume a flat world; open planets have few walls; leashing keeps AI near camps.
- **D5 (planning):** no ammo items; weapons have magazines and reload times. Why: fewer items to drop,
  balance and display; keeps inventories readable.
- **D6 (planning):** email sign-in tests use a disposable test inbox the builder reads by API (e.g.
  mail.tm), never the owner's inbox. Why: privacy, and tests must run without the owner.
- **D7 (planning):** vanilla three.js for the 3D layer (no React Three Fiber), React 19 only for the DOM
  UI, no ECS library. Why: direct control of WebGPURenderer and the frame loop; fewer moving parts.
- **D8 (planning):** destruction debris uses small custom physics (radial gravity, terrain collision,
  damping), not Rapier. Why: Rapier's compat build is 1.65 MB gzip of the load budget and debris is
  cosmetic. Revisit only if debris looks wrong.
- **D9 (planning):** server deploys are batched (≈ one per 30 min during the run, as needed after launch).
  Why: a Railway service with a volume runs one replica, so every deploy disconnects every player.
- **D10 (planning):** `playfirstlight.vercel.app` redirects to `firstlight.one4all.dev` instead of serving
  the game. Why: `vercel.app` is a public suffix with its own cookie jar and fails the auth origin check.
- **D11 (planning):** our own OTP budget: ≤ 3 codes per email per hour and ≤ 80 per day while Resend is on
  the free plan (100/day). Why: Better Auth reports success even when sending fails; Resend's cap is
  shared with the owner's other uses.
- **D12 (planning):** solo players only enter a world copy with fewer than 36 players; 4 seats stay free for
  parties. Why: Colyseus rejects joining a full room by id, so "party always lands in the leader's copy"
  needs headroom.
- **D13 (planning):** R reloads. Why: magazines (D5) need a reload key; R is the standard.
- **D14 (planning):** cosmetics drop on death like every other item. Why: R2 Q4 ("cosmetics are items
  too, so they drop") and R4 Q5 (only account, name, medals and Hall of Firsts are kept).
- **D15 (planning):** the safe ring around each fast-travel pad has a 12 m radius. Why: big enough to
  arrive and log out safely, small enough that pads don't become fortresses.
- **D16 (planning):** keep the boss name "the Hollow King" (owner-approved in R1–R3; generic words; not a
  game title). Fallback if challenged: "the Mere King".
- **D17 (planning):** three-piñata is MIT (npm licence field + LICENSE in the published tarball). Use the
  npm package only; never copy its unlicensed `demo/` code.
- **D18 (planning):** ElevenLabs is on the owner's paid Starter plan (commercial use allowed). Budget: 9
  boss lines (289 characters) + voice design ≈ 590 of the 794 credits.
- **D19 (planning):** time to level 20 ≈ 112 minutes of focused play (`XP_to_next = round5(50 × L^1.5)`).
  Why: meets "level 2 in ~1 min, level 5 in ~10 min"; one knob to retune.
- **D20 (run, 01:20Z):** Resend is on the owner's paid Transactional Pro plan (Codex checked), so the
  global OTP budget rises from 80/day to 1,000/day; the per-email cap stays 3/hour. Supersedes D11's
  global number.
- **D21 (run, 01:20Z):** Cloudflare has no signed-in account in Chrome; creating one means accepting
  Cloudflare's terms, which needs the owner. Asked the owner (non-blocking). Voice and asset hosting
  are built and tested locally meanwhile.
- **D22 (run, 01:40Z):** owner is using the Mac: all Codex computer-use (Chrome/mouse) work is paused
  until the owner says the screen is free. Code-only work continues; visual checks queue up.
- **D23 (run, 01:55Z):** owner asked to stop using Chrome/computer use (it took over the mouse even
  after cancelling: Codex left a cua kernel + osascript running; both killed). All UI/E2E/visual
  checks move to T3 Code's built-in browser (owner-named tool), which is isolated from the owner's
  mouse. Codex stays for code review and non-GUI work only; no Codex computer use unless the owner
  re-enables it. Supersedes the Codex-computer-use parts of R4 Q13/Q14 and SPEC §9.3.
- **D24 (run, 02:25Z):** Cloudflare: account signed in by the owner; Workers token saved and verified
  (an invalid duplicate line removed); workers.dev subdomain is `rosty-build`, so assets will be at
  `firstlight-assets.rosty-build.workers.dev`. The token can't create TURN keys (no Calls permission);
  the owner creates the TURN key in the dashboard and stores it with `~/.config/firstlight/save-turn-key.sh`
  (secret never shown to the builder).
- **D25 (run, 01:30Z):** game UI is plain DOM + CSS (no React/Vue). Why: a handful of screens, the
  canvas owns the frame loop, and a framework adds bundle and re-render cost for no gain here.
- **D26 (run, 02:10Z):** server hardening after the three-model combat/auth review (Codex Sol, Opus,
  Sonnet; docs/reviews/2026-10-12-*): one authoritative actor per user (process hub; a new session
  takes over the old one, which is retired with app close code 4100; merges use 4101, bans 4102,
  logout 4103); pile + character writes in one SQLite transaction; server-side movement budget, fall
  damage, bow/heavy charge timers and cooldowns; travel only through a portal (`travel` → server
  ticket in the character, checked by /api/play); party placement only from the server's party
  system; account ids never synced to clients; load-test bots never persist; repeat PvP kills on the
  same victim within 10 min give 10% XP; inventory ops ≤ 5/s; per-IP OTP cap 8/h and "+tag" aliases
  share one budget; admin claim needs a saved (email) account. Note: the D20–D24 timestamps above were
  mislabelled (the run started 00:46Z, commits confirm); order is right, clock times are not.
- **D27 (run, 02:35Z):** merged lane/social. Player user ids stay in the room state (they are random
  opaque ids, not credentials; blocks, mutes and parties need them) — reverses that part of D26.
  One close-code table in `packages/shared/src/net/social.ts`: 4100 elsewhere, 4101 merged, 4102
  banned, 4103 logged out, 4104 kicked (social's 4001/4003/4004 sat in Colyseus's reserved range).
  Party headroom comes from the social party system (`partyRoomFor`); a client room hint is honoured
  only if a party member is in it. `/api/play` checks bans/kicks before travel tickets. Test helper
  `joinAs` grants a travel ticket (tests hop bodies); `rules.test.ts` covers the real ticket path.
- **D28 (run, 03:25Z):** terrain landmarks moved off degenerate anchors (lanes reported them):
  Tolling Tower was centred exactly on Hollowmere pad 10 (its triple held two opposite pads) → now
  `between: [10, 8, 0.15]` (125 m from pad 10; the Hollow Nave lies past its foot). Chrome Spires sat
  on Meridian pad 15 → `between: [15, 9, 0.45]` (the Oversight Lobby stays on flat ground at its
  foot). Signal Ridge was the midpoint of two opposite pads (no direction) → `mid: [2, 0]`. New anchor
  form `between`; `anchors.test.ts` rejects collapsing anchors and pads inside a feature's core.
  F2 re-run with NPCs on production: 40 bots × 600 s, 0 failures, tick p95 ≤ 2.94 ms, RSS ≤ 218 MB.
- **D29 (run, 03:40Z):** performance gates are measured in T3 Code's built-in browser (Chromium 152,
  WebGPU) on the owner's M1 instead of Chrome (D23 forbids driving the owner's Chrome). F11's DevTools
  "4× CPU slowdown" is emulated with `?cpuslow=4` (busy-waits 3× each frame's main-thread time).
  three's WebGPU timestamp "GPU ms" sums overlapping passes on Apple GPUs (read 48–68 ms at 60 fps),
  so the probe and ladder ignore a GPU p50 above 1.25× the frame interval and use frame timing.

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
- **D30 (run, 06:58Z):** player state is not interest-filtered. Every player's position, facing, HP,
  level, weapon, party, name and `userId` in a body room copy goes to every client in that copy
  (`BodyState.players` in `packages/shared/src/net/schema.ts` has no `.view()`; only NPCs and piles
  are view-filtered in `BodyRoom.updateViews`). This is the fallback SPEC §5.2 names ("one shared
  un-viewed player map"), now recorded as the shipped design. Why: copies are capped (40 players,
  `MAX_CLIENTS`), the client needs it (map and compass party markers, party frames, the Tab player
  list, nameplates, the voice planner's nearest peers), and per-client player views cost encode time
  for little gain at this size. The trade-off, stated plainly: a modified client can draw every
  player in its copy with HP through walls or as a radar, a wallhack the game can't prevent, and
  the full player map costs bandwidth (the F12 Sonnet review measured about 17 KB/s per client with
  40 players moving). `userId` is a random opaque account id, not PII and not a credential (D27).
  Interest management or fog-of-war filtering (an unfiltered roster of name/level/party plus
  view-filtered position/HP/weapon) is out of scope until copies grow past the cap or cheating shows up.
- **D31 (run, 06:58Z):** before the repo goes public the owner works through `docs/pre-public.md`
  (history scrub of `docs/reviews/firstlook-1.png`, Easter-egg solutions out of the public source,
  no local paths or personal emails, licences, a secret scan of the whole history, third-party IP
  wording). Why: making the repo public is an owner-only step (Process, R4 Q2), and some items rewrite
  history or change live puzzles, which needs the owner's go-ahead.
- **D32 (run, 11:55Z):** server movement and session rules after the F12 rounds. A takeover keeps
  the old session's protection expiry, cooldowns and effects; fresh spawn protection only without a
  live, dropped or lingering body. Safe zones and portal handoffs skip the 30 s body linger only out
  of combat; travel tickets last 60 s and are refused while combat-tagged. New characters start in
  Portus only. A seat is valid once, for its own account, rechecked when used; ≤ 2 unused seats per
  account, ≤ 10 per address. Movement (`world/movement.ts`): ground covered is charged, height is
  bounded by the jump/air envelope from the last support (terrain or an intact prop top), a step
  onto a prop top from below must fit a jump, a path through a prop is refused, moves near the
  planet centre or with non-finite numbers are refused, a saved position that is broken or > 3 m
  underground rejoins at the pad, one shared swim depth (1.2 m). Dodges are paid from a 1.6 m
  reserve that refills over one cooldown (1.2 s): honest rolling at every cooldown is never
  corrected, and a modified client gains at most ~12 % over sprinting (T9 review probe). Message
  caps per player per second: ping 20, travel 2, respawn 1, questSync/client:info/skySync 2;
  malformed messages are dropped, 20 in 10 s disconnects. `PROTOCOL_VERSION` gates `/api/play`
  (bump it for any incompatible message or schedule change, e.g. the lightning schedule).
  Why: the F12 reviews' blockers (flight, takeover resets, combat logout, stale seats, teleport via
  the centre) and the honest-player corrections the later probes found.
- **D33 (run, 11:55Z):** persistence rules. Every reward that pays XP saves XP/level with everything
  else it pays in one transaction; level-up effects and messages follow the commit and never save
  again. Kill and boss payouts whose save fails are retried after 1, 3 and 6 s (once per key) and
  get one last try when the room closes; a recipient who left, died or was reborn forfeits their
  share, ground loot still lands. A death that can't be saved drops the session (4002) and the
  account is refused (4105, `/api/play` 503 `storage`) until a health write succeeds; an expired
  mark arms a global health check. Per-copy world state (boss timers and fights within 30 s of
  vacancy, cleared/part-killed groups, the Golden Hopbit timer, broken props, staged/assisted marks)
  lives in `copy_state` (migration 3), checkpointed ≤ 1/s with backoff on failure. Piles have
  kinds (death/loot/staged) and expiry (migration 4); past the cap: staged, then loot, then death
  piles older than 10 min, soft-capped at twice the cap. Admin voice mutes persist (migration 5).
  Why: F12 blockers B6 (dupes), Opus B2 (boss reset) and the final-round payout-after-commit findings.
- **D34 (run, 11:55Z):** auth and abuse rules. A sign-in code is emailed only to a saved address or
  to a signed-in player at level ≥ 2; every public request gets the same immediate answer and saved
  addresses get their code from a background queue; unused email-OTP endpoints and
  `/delete-anonymous-user` are disabled; every failed code gets one 400 answer. Budgets: ≤ 10 codes
  per account per day, banned accounts none, public sends ≤ 60 % of the daily budget and ≤ 5 per
  client IP (/64) per day, separate hourly per-address caps for public and level-2 sends.
  Production pins Better Auth's Origin/CSRF checks on. Guests idle > 30 days at level ≤ 2 with
  ≤ 50 XP and no medal but Spark are pruned in recoverable steps (≤ 5,000 per run), names freed.
  Reserved display names: staff/game words at name-part boundaries, admin/oversight/sysop at either
  end, server/support/system/official as prefixes, with ordinary-word exceptions. Why: the F12
  reviews' enumeration, budget-drain, squatting and impersonation findings; easy to loosen later.
- **D35 (run, 11:55Z):** social and voice: a block acts on voice only when new; it rotates the
  blocked player's relay credential only if the pair relayed signalling within 12 h, at most once
  per player per 10 min, outside their mint budget (mint before revoke). A block withdraws invites
  and splits a shared party (leader blocks → the other leaves; otherwise the blocker leaves),
  including blocks merged in by a guest→account link. Reports: 5 per 10 min per account, one per
  target, shared by voice and the Tab list, only against players seen in the last 10 min. Why: Opus
  F12 B1 (voice DoS by repeated blocks) and stalking risk R1.
- **D36 (run, 11:55Z):** NPC and boss rules: an NPC whose target is out of reach (pad ring, other
  medium, perched above melee reach) for 5 s with no ranged attack that reaches evades home and
  heals; boss HP scaling and targeting count players in the arena plus anyone who hit it in the
  last 10 s, hits from beyond radius + 10 m deal nothing and edge hits count only while someone
  alive is inside; arena cover and props block shots, NPC sight and NPC bolts. Staged copies (30
  min) and admin-assisted fights (15 min) write no medals or Hall of Firsts (Spark exempt);
  egg-penalty and staged spawns are capped, expire and pay nothing. Why: F12 pad-cheese, sniping,
  staging and XP-faucet findings.
- **D37 (run, 11:55Z):** onboarding and inventory: the tutorial is offered once per account to a
  level-1, never-died character in Portus; three training dummies (server-validated `train` hits)
  pay 10 XP each and +20 with the Spark medal on completion, in one transaction and only on the
  first durable transition; six free tips follow (switch, pick up, map, phrase wheel, optional
  voice, walk into a portal); skipping keeps XP already earned. The level-2 save prompt waits until
  the tutorial is over and never takes focus while the pointer is locked. Loot goes to the backpack
  except weapon-table items (not the radio), which prefer the hotbar; X on a hovered slot needs a
  second press. Why: Sonnet F12 B2 and should-fix 6, and the T9 browser run.
- **D38 (run, 21:15Z):** Portus is the castle town (the owner's pick: the Opus design): 215 placed
  prefabs from the CC0 Quaternius village and nature kits, rebuilt by `tools/blender/portus/build.sh`
  (verified archives, data-only extraction) into a 2.8 MB asset and generated shared data
  (`content/portusTown.ts`: layout, collider solids, paved ground). The town frame is the game's
  pole frame (east −X, north +Z, geodesic offsets like `places.offsetDir`); the portal courts sit at
  the portals' real arc (16.928 m, `portals.ts` uses 17 m on the tangent plane). The Portus floor is
  flat (exactly the radius) out to 72 m chord, not 50: the castle's far towers stand at 64 m; the
  rim and hills start beyond it and the terrain is unchanged from 132 m on. Spawn, pads, portals,
  Juno, the Hall wall and the dummies were already on flat ground (≤ 28 m) and did not move; Portus
  keeps 0 breakables. Natural props stay outside 52 m, 3 m off the town's paving, roads and
  structures and out from under its trees (render-only; nothing authoritative reads Portus props;
  `PROPS_VERSION` 3 → 4 on top of the vegetation lane's 3). Why: the owner wanted the start
  inside a village with a castle, and the design's walls (r 43–46) and castle sat on the old 0–7 m rim.
- **D39 (run, 21:15Z):** the town's walls, towers, gatehouses, keep, houses, halls, courts, stalls
  and props are shared, indestructible colliders (`planet/town.ts` StructureCollider: one box or
  upright cylinder per solid, resolved by the breakable collider code generalised to `SolidFrame`),
  never in the breakable list (its ids and indices are wire/persistence keys). The client controller
  (`setStructures`) and the server's movement world (tops hold feet; inside and crossing refused) use
  the same solids. Gate passages are 3.8 m (2.2 m for the body's centre between the open doors), the
  castle gate 3.4 m. Solids follow their prefab's frame, so the keep's front steps stand 0.44 m above
  the curved ground at their far edge: a hop, like the drawn step. Client tracers stop at town walls;
  the server's shot and NPC sight paths don't consult them, because Portus refuses shots (safe zone)
  and has no NPCs (`StructureCollider.raycast` is ready if that changes). The server puts players
  down (restored saves, the spawn ring, admin and quest teleports, stage spots) with
  `BodyRoom.placeBody`: on the ground and cleared of structures the way the client's first frame
  pushes (`clearSpot`, 2 cm to spare; nearest clear ring spot where pushes can't settle), so a save
  inside the keep can't loop on corrections (review round 1, B1); the move budget is unchanged.
  The Hall of Firsts board's stand (plinth, backing, posts, cornice; drawn by QuestWorld) is part of
  the same shared solids, placed at the authoritative `hall_wall` spot facing the plaza (round 2, S4).
  Why: the brief's "solid to walk into", with one set of solids so the server never corrects an
  honest client.
- **D40 (run, 21:15Z):** deploying the town: `PROTOCOL_VERSION` 2 → 3, and the client (Vercel, with
  `assets-dev/portus`) goes first, the server right after in the same batch (D9). An old client on
  the new server walks the old 7 m rim at 28–72 m (the server sees it hovering: height refusals and
  pull-downs, rubber-banding) and into invisible houses (prop refusals); a new client on the old
  server can't walk past ~32 m (its floor is up to 7 m under the old rim: ground refusals) and is
  stricter around buildings (no corrections). Without the bump old tabs would keep the first case
  until reloaded; with it their rejoin after the server deploy gets 409 and reloads once into the new
  client. Client first means only page loads in the gap can't join (409, one reload, then an error);
  server first would lock every player out until the client lands. Why: corrections are harmless in
  a safe zone but constant ones aren't playable; the version gate ends mixed sessions.
- **D41 (run, 21:15Z):** the town renders as one merged mesh per material and LOD, baked at load
  from the shared layout: opaque and alpha-tested cutout, LOD0 (198k triangles) and LOD1 (146k: roof
  shells, no vines, tree cards). All kit materials are per-vertex slots over two 16-layer 512 px
  texture arrays (WebP strips, canvas-decoded, cutout colour premultiplied), so the town is 2 draws
  + 2 shadow draws on Medium; measured against 32/64/96 m cells (19–23 + 19, 8–12 + 10, 6 + 8 draws)
  because frustum culling saved < 15 % of the triangles from the plaza. The opaque town casts through
  a depth-only copy on a layer only the sun's shadow camera renders (positions only, roof shells,
  no paving or window glass: 136.8k instead of 170.8k triangles, no texture work in the shadow pass);
  shadow cells were measured and rejected (48 m: +8 draws at the spawn for −9 % triangles). Medium+ shows LOD0 unless
  the camera is 60/90/140 m beyond the town's bounds; Low shows LOD1 without normal maps or shadows.
  If the asset fails, or isn't there 18 s into the arrival (the download itself aborts at 15 s), the
  colliders are drawn as stone boxes (2 draws) before the probe and the warm-up, and a later arrival
  of the asset is ignored until the next visit (review round 1, S1). Why: Medium was already at
  ~290 draws against 250 (F10); triangles are cheap next to draws on Metal (#30560).
- **D-zones-1 (run, 2026-10-15):** Portus: the castle town is the safe zone and the land outside its
  walls is wild, with creeps. Amends "Safe zones: all of Portus" (R2 Q3) and D39's "Portus refuses
  shots and has no NPCs". The safe footprint is the curtain-wall ring, 46 m from the pole (through
  the middle of both gatehouses: the gates are the border), plus the castle ward (|east| ≤ 16.4 m,
  north ≤ 64.1 m). One shared function decides it, `packages/shared/src/planet/zones.ts`
  (`zoneAt`, `isSafe`, `nearSafeZone`, `nearestSafeEntry`): the server's SAFE flag (with the 10 s
  combat tag), logout, horses (the whistle now works outside the walls), NPC steering and the
  client's HUD zone label all read it. Arrival, respawn, rebirth, the dummies, the portals, Juno and
  the Hall are inside. Outside: eight fixed groups (`PORTUS_WILDS`, levels 1–2): Woolbacks within
  ~20 m of each gate, three Hopbits on the rim ~45 m out from each (past their 25 m sight from the
  gate, so nobody is jumped on the doorstep), Hopbits south and behind the castle, Woolbacks and
  two Sparkflies over the rim. Hostile homes keep their wander room plus the 3 m NPC
  margin clear of the town; steering keeps every NPC out (as at pad rings, D36: an unreachable
  target → evade after 5 s). Kills pay from Arcadia's tonic and cosmetic tables. The HUD shows an
  always-on zone label (Safe / Danger, `[data-e2e="zone-label"]` with `data-zone`) from the
  server's flag, the border banner ("Leaving the safe zone · Creeps and other players can hurt you",
  "Safe zone · Portus town · no damage in or out"), a glowing line in the pad rings' colour marks
  the border across both gate passages (one draw), and the compass's SAFE marker points at the
  nearer gate. Inside the walls (away from the gates and below the wall tops) the client draws no
  creeps (they are hidden by the walls anyway), so the NPC layer's ~10–14 draws stay off the plaza's
  budget (D41). The town's walls stop combat too (D-zones-3). No `PROTOCOL_VERSION` bump: the
  client's label and refusals read the server's flag, and old clients draw the Portus creeps with
  the existing NPC layer. Why: the owner started in the
  castle, "fired" at the training dummies inside (tutorial `train` shots), walked out of the gate
  into what reads as danger, found shots refused ("Weapons are holstered in safe zones") and no
  creeps: "the safe zone was not on the inside, it was on the outside". Inside the walls safe,
  outside danger is what a player expects.
- **D-zones-2 (run, 2026-10-15):** creeps near every arrival. Each planet's main pad has a grazing
  herd at ~42 m and a pack of the planet's weakest hostiles at ~62 m (outside the 45 m rule with
  their wander room, which stays), placed toward where the arrival camera looks (the portal home)
  on dry ground (`ARRIVAL_GROUPS`, spawns.ts step 0): Hollowmere Woolbacks L6 and three Bonewalkers
  L6, Meridian Woolbacks L12 and three Associates L12. Arcadia already had both ahead of the camera
  (Woolbacks at 47 m, Hopbits at 68 m; npc-spawns.test.ts holds all three). Measured before: the
  first hostile was 68 / 66 / 134 m and the first wildlife 47 / 181 / 1,095 m from the Arcadia /
  Hollowmere / Meridian arrival, and the client only receives NPCs within 80 m (server AOI; drawn to
  150 m, full detail within 45 m), so Meridian showed nothing on arrival. Also: an attack the
  server refuses for "protected" (the 5 s after arriving), "swimming", "mounted", "overheated" or
  "safe zone" now shows a toast (one per reason per 1.5 s), and melee refusals are sent as
  `denied` like ranged ones. The tracked hunt mission (missions.ts `trackedMission`: the first open
  mission given out on this planet, else the first open one; the HUD tracker and the pointer share
  it) gets a world callout, pinned to the screen edge when off screen: the nearest creep in view
  whose kill would count, else the area. Which creeps count is the server's answer: `huntTargets`
  {id, npcs} lists the tracked hunt's NPCs within 110 m by the kill-credit rule itself
  (`huntCredit`: kind, the NPC's spawn area for place-bound hunts, quotas from the per-target
  `counts` now in `you.missions`), sent when the list changes (A1 points at the
  Clover Fields Hopbits 68 m from Dawnpad; H1 at a Cantor in view; M1 at Checkpoint Seven). H1
  and M1 still send players to their designed camps, not to the arrival packs; changing those
  missions is the owner's call. Why: "Where are all the creeps outside? Let's see the creeps."
- **D-zones-3 (run, 2026-10-15, Codex review):** the Portus town's walls stop combat, and the town
  protects at once. The town's indestructible structures (the shared `StructureCollider`, the same
  solids movement uses) are the combat host's `walls`: they stop hitscan shots, pellets, chain
  bolts, projectiles (a rocket bursts on the near side), melee, line of sight and Patchkit/chain
  lines, shelter whoever stands behind them from blasts (breakable props keep their old rule), stop
  NPC sight, NPC bolts and NPC strikes (from the strike's source to the player's chest), and the
  hammer's slam; NPCs walk round the crates, trees and towers outside the walls (blocked, they
  keep turning to the side they last slid to, sideways and back if need be). Combat tags: whoever
  is inside the town walls is protected at once, tagged or not, and the attack and damage gates
  ask where the player stands now (`BodyRoom.safeNow`), not the flag the tick writes, so a move
  into the town counts before the next tick (Codex round 2); the 10 s tag still holds on the pad rings (F12:
  no running onto a pad mid-fight) and still blocks an instant logout everywhere. Why: Codex showed
  a tagged player inside the walls taking carbine hits through 14 m of wall. The town is the one
  place a new player must be able to trust, its 8 m walls and two gates make "inside" obvious, and
  NPCs can't follow anyone in. The cost: a player can step out of a gate, shoot and step back in;
  the gates are narrow and in plain view, and the planets' pad rings keep the stricter rule.
- **D-sfx-1 (run, 10:00Z):** sound effects become ElevenLabs samples served like the boss lines:
  never in git, a versioned set on the asset Worker at `/v/sfx-1/` (`config.sfxBase`,
  `VITE_SFX_BASE`) with a `manifest.json` listing each sound's takes and playback gain. The client
  (`audio/samples.ts`) fetches the manifest at start, decodes every file once and plays a random take
  (never the same one twice in a row) with ±6 % pitch and −1.5 dB…0 level jitter. Any sound without a
  loaded file plays its ZzFX preset (`audio/presets.ts`, mapping in `audio/sounds.ts`), so a missing
  set, file or decode never silences an event; `?zzfx` skips the samples. The owner's "ping" was the
  hit marker, a 1.6 kHz triangle on every landed hit (tutorial dummies included); it and the 900 Hz
  UI blip also get soft low ZzFX stand-ins. Melee swings are per weapon (sword, staff, fists, axe and
  hammer), magic bolts land with a magic hit, and weak-point hits have their own sound. Each sound is
  levelled to the ZzFX sound it replaces (loudest 400 ms, K-weighted). Its playback gain is capped
  so that the loudest decoded take stays under −1 dBFS with master and effects at 100 %. `process.ts`
  applies the cap and checks it, and the client caps again from the decoded buffers. So sounds
  whose ZzFX version was loud play quieter than before: the carbine and the hurt sound by about
  5 dB, the sword swish by about 7 dB, and the portal, Emberglass and Comet by 9–14 dB. The prompts and processing are in `tools/sfx`, which
  writes to `/tmp/fl-go/sfx`. Why: the owner asked for a sword swish, a magic wand and better weapon
  and UI sounds. The boss-line rule (D18, ASSETS) keeps ElevenLabs output out of the CC BY repo, and
  the manifest keeps the client free of file lists: takes can be dropped or added before the upload
  with no code change. After the upload a change needs a new set (`sfx-2` and a `config.sfxBase`
  bump), because `/v/*` is cached as immutable.
- **D-sfx-2 (run, 10:00Z):** ElevenLabs budget and terms for the SFX. The account had 678 of 40,000
  credits left (Starter; resets 16 Oct 2026 19:53Z; the boss lines were already made). The
  sound-effects API bills 10 credits per second of the requested `duration_seconds` (the
  `character-cost` header: 0.5 s = 5, 1.5 s = 15), so the tools always set the duration. The first
  set took 67 takes for 470 credits, keeping 65 files (412 KB), which leaves 208 credits for retakes
  after the owner hears the preview. Terms (checked 15 Oct 2026):
  - paid plans may use the output commercially (Terms of Use §1(c));
  - the user keeps the rights in their output (§4(c)(ii)), and ElevenLabs keeps a licence to it (§4(d));
  - the sound-effects FAQ (elevenlabs.io/sound-effects/commercial) says paid plans need no
    attribution, and asks users not to use the output to build competing products.
  So the files stay out of the repo and out of any reusable pack, and the set carries a `NOTICE.txt`.
  Why: the owner set a hard limit of the credits left, with no top-up.
- **D-home-1 (run, 2026-10-15 05:20Z):** the landing page is now the home page (6a): Play/Continue,
  my progress, Save your progress (guests), Sign in / Sign out, online now per world, the
  leaderboard (top levels, Hall of Firsts, medals) and the four worlds. Opening it never creates a
  guest: it reads `/api/account/me` only when this browser already has a session, and only Play signs
  in anonymously. Sign out is offered to saved accounts only (signing a guest out would orphan its
  character) and clears the local starter, palette and body so the next player picks their own.
  Why: one click to play stays guest-friendly, and a returning player sees their character first.
- **D-home-2 (run, 2026-10-15 05:20Z):** logging out (and "Back to the home page" after a removal)
  reloads the page into the home page instead of showing the LOGGED OUT card over the stopped game
  (`home/leave.ts`, `?autoplay` stripped, a one-shot notice in sessionStorage). Navigation frees the
  renderer, the GPU device, the frame loop, workers, audio and every listener at once; tearing the
  game down in place would need a dispose path through every system and lane. The server has saved
  the character before it sends `loggedOut`, so the client waits at most 2.5 s for the leave. Why:
  robust teardown with no leak risk; the cached bundle makes Continue as fast as before.
- **D-home-3 (run, 2026-10-15 05:20Z):** `GET /api/home` is public and shows display names only:
  per-body counts with up to 12 in-world names each (the names every player already sees above heads
  and in the Tab list; load-test bots excluded), the top 10 live characters by level, the top 10
  accounts by medal count (medals survive death, so an account between lives stays on that board),
  both for accounts with a chosen display name only and never banned ones, and the claimed Hall of
  Firsts plaques. No ids, emails, positions or room copies. Cached (online 3 s, board 60 s) and
  limited to 30 requests per address per minute (IPv6 per /64), keyed by `directRequestIp`, the
  helper `/api/play`'s per-address limits and IP bans use. Both boards read their top rows from
  indexes (migration 6: `character_rank`, and `medal_count` kept by triggers on `medal`), so a
  refresh costs well under a millisecond at 100,000 characters instead of ~120 ms of sorting each. There is no "hide me
  from the home page" setting yet; add one if players ask. Why: the owner asked for names "if
  privacy allows"; public names that are already public in the world, nothing more.
- **D-home-4 (run, 2026-10-15 05:20Z):** DataFast (6f) is optional on both sides. The client build
  injects DataFast's script into `index.html` only when `VITE_DATAFAST_WEBSITE_ID` and
  `VITE_DATAFAST_DOMAIN` are set (`vite.config.ts`, values validated), and uses the cookieless script
  (`script.cookieless.js`, no visitor cookies, so no cookie banner for DataFast; turn on
  "Cookieless / privacy mode" in the DataFast website settings to match; `VITE_DATAFAST_COOKIELESS=false`
  switches to the cookie script). The server reads realtime visitors (last 10 min) and all-time
  sessions with `DATAFAST_API_KEY` (a `df_` website key, server-only, never logged), cached ≥ 60 s,
  one request pair at a time, the last numbers kept on failure. Without it the home page shows our
  own online count and no visits; with it, "Online now: N · Total visits: M". Whenever the script is
  in the page a one-line note says so: "Cookieless analytics by DataFast", or that DataFast sets
  cookies when the cookie script was chosen. Why: the key stays secret, the page works tonight with or without the account.
- **D-home-5 (run, 2026-10-15 05:20Z):** share row (6e) on the home page and in the Esc menu: Share
  uses the Web Share sheet where there is one, else copies `https://firstlight.one4all.dev` with a
  toast; Email is a `mailto:` invite; "Follow on 𝕏" appears only when `VITE_X_HANDLE` is a valid
  handle (never guessed: it publishes under the owner's name); the eye hides the home page to show
  the backdrop. Screenshots stay on P (its own share dialog). Why: the owner's littleprince.dev bar,
  without inventing an account.
- **D-controls-1 (2026-10-15):** Voice chat and the radio are hidden in this build ("Voice chat: coming
  soon"), behind a flag on each side, not deleted. Server `FEATURE_VOICE=1` / client build
  `VITE_FEATURE_VOICE=1` bring them back (both, together). Off: no voice system (the voice and radio
  message types stay registered and answer `voice:denied {reason: "off"}`, so older tabs aren't
  dropped), no TURN credentials minted, the Exchange doesn't sell the radio, a radio can't be dropped
  and one carried into death goes with the old life instead of into the pile; the client has no V/B
  keys, no mic prompt, no voice pill, no voice tutorial tip (step ids unchanged; a saved voice tip is
  kept), no Voice volume or voice column, no voice column or mute in the Tab list, and an owned radio
  reads as an empty slot. The Esc menu shows one disabled "Voice chat: coming soon" line. Block and
  report (Tab list) and the phrase wheel stay. Why: the owner isn't sure about the legal side of live
  voice (risk-assessment §5: the terms page, a public complaints contact and a real legal check are
  still missing), and wants "character should just walk around and do basic" for this build.
- **D-controls-2 (2026-10-15):** No F-key bindings. Performance overlay `` ` `` (was F3), photo mode
  Shift+P (was F9; P alone stays the screenshot), admin console Shift+`` ` `` (was `` ` ``). The game
  no longer swallows F-keys (the browser keeps F5/F11/F12); it swallows `` ` `` and `'` while locked.
  `game/keys.ts` lists every binding and a test checks for F-keys and clashes. Why: on a Mac F1–F12
  are system keys (F3 is Mission Control) and the owner's Fn key belongs to another app.
- **D-controls-3 (2026-10-15):** The pause menu follows a state machine (`ui/pauseFlow.ts`), not every
  `pointerlockchange`. Esc in the menu (also Enter/Space, Resume, a click on the backdrop) goes back to
  the game: the menu closes, a "Click to look around" hint shows, and the next click on the world
  re-locks without reopening the menu. An unlock opens the menu only after it has lasted 150 ms, and a
  lock lost within 500 ms of being granted lands in the game with the hint instead of reopening the
  menu (the owner's blink: Chrome granted the lock and dropped it a few frames later, and the old menu
  mirrored both changes). Refused lock requests (no gesture, Chrome's ~1 s block after an Esc) show the
  hint. Esc in a panel closes it and asks for the pointer back (the panel freed it itself, so Chrome
  allows it without a click). Play still goes fullscreen, now with Keyboard Lock for Esc where it
  exists (Chromium): a short Esc reaches the game (menu, then straight back in without a click) instead
  of dropping out of fullscreen, and holding Esc leaves fullscreen; the menu has a Full screen button.
  The cost: an Esc pressed within 500 ms of clicking into the game shows the hint rather than the
  menu (a second Esc opens it). Why: Esc alone can't re-lock the pointer (it isn't a user gesture),
  and Esc dropping fullscreen gave the owner a full-screen jump on every pause.
- **D-map-1 (map lane, 2026-10-15):** one north for the whole client: the D38 pole frame, toward
  the body's +Z pole (`social/compassMath.ts` `northAt`/`eastAt`, the same as `places.tangentFrame`
  wherever that frame is taken from +Z). The compass used to point north at the +Y pole, where
  Portus sits: at the plaza it fell back to −Z and around it pointed back at the centre, so facing
  the castle (town north) it read S while the map drew the castle up — the owner's "the map is
  inverted". The map and the minimap take north from the same functions, and tests pin "a point due
  east draws right of you, north up" and "every target sits at its compass bearing". Why: the town,
  the places' east/north offsets and the map already used +Z; a north at the hub's own pole is
  undefined exactly where every player starts.
- **D-map-2 (map lane, 2026-10-15):** the map and the minimap draw the ground from one colour atlas
  per body (six cube faces, ~0.75 m texels on Portus, 2–3 m on the planets), baked once per arrival
  in a worker (`world/mapAtlas.worker.ts`, the face under you first) from the shared height function
  and the terrain palette, hill-shaded from the north-west; Portus adds its town plan from a 0.5 m
  raster of the shared layout. The worker also renders the views (the map's globe, the minimap's
  north-up tile around you, refreshed after a quarter of its span) and hands back bitmaps, so the
  main thread only draws images and markers: the minimap is one canvas, ~0.1–0.2 ms a frame (tile
  swaps included, p99 0.3 ms), and Medium held 60 fps with it on and off in a headless WebGPU A/B.
  Why: the old map re-sampled terrain on the main thread per view (22k samples, 72-res while
  dragging); a per-frame minimap couldn't afford that.
- **D-map-3 (map lane, 2026-10-15):** the waypoint is client-only, one per body in localStorage
  (`fl.waypoint.<body>`), dropped by clicking the map (or F over it), cleared by right-click, the
  map's button or arriving within 8 m. It shows on the map, the minimap (pinned to the rim when far),
  the compass (magenta diamond with its distance) and in the world as an unfogged magenta pillar that
  widens with distance (normal blending: additive vanished against daylight sky). Clicking a pad still
  fast-travels when you stand on one; otherwise it sets the waypoint there. On the map, unnamed pads
  read "Pad N" (shared `padName` says "Waypoint N", which the server's pad toasts still use). Why:
  the owner wants "a dot where to go"; sharing it with the party can come later over the party channel.
- **D-map-4 (map lane, 2026-10-15):** the minimap is the first child of the HUD's right column (top
  right; the mission tracker and toasts flow below it), round, turning with the camera by default
  (settings: Minimap, Turn the minimap with the camera; the map's North up / Heading up is
  remembered too). Twice a second it measures the tutorial panel, the player card, the hotbar and
  the save card (the `calloutPlace` idea) and shrinks, down to 110 px, then hides rather than overlap
  them. It shows 60 m around you on Portus and 110 m on the planets: NPCs (hostile or aggroed red,
  bosses ringed, wildlife cream), pads, portals, the guide, mission stars, party and the waypoint.
  Why: top right is the one corner nothing else owns at play time.
- **D-combat-1 (2026-10-15 overnight):** a ranged shot's origin slides along the aim ray to the
  point nearest the shooter's head before the 7 m `ORIGIN_SLACK` check (`aimOrigin`, combat.ts;
  training shots too). The client sends the camera position, and the mouse wheel zooms the camera
  out to 9 m: past ~7 m every Hexquill and carbine shot was refused as "origin", silently (a likely
  cause of the owner's "weapons don't work outside"). A line that never comes near the head is still
  refused. Melee refusals now answer `denied` like fire, and the client shows a notice for each
  attack refusal (safe zone, arrival protection, overheat, reload, swimming, saddle). Why: the aim
  line is what counts; where along it the camera sits is a view setting, not a cheat.
- **D-combat-2 (2026-10-15 overnight):** the dodge-roll keeps C (SPEC §4.4, D1; S stays the back
  step, no double-tap). It starts on the frame C is read, as before, plus: content §0's 100 ms input
  buffer (a press that early rolls when the cooldown ends or on touchdown; an earlier press is
  dropped, never queued into a late roll), 0.12 s of ground grace after stepping off an edge (not
  after a jump), the body turned to the roll at once, and the clip cut from the lean (frame 6, not
  the crouch at 2) with a 0.05 s blend. Keys pressed behind a loading screen are dropped. Why: the
  owner's "it takes a second before it rolls": measured headless, the roll pose showed 75–150 ms
  after the key (the clip stood up first), presses in the cooldown's last moment or just before
  landing were lost, and a C pressed while travelling rolled on arrival. Now 25–75 ms.
- **D-controls-4 (2026-10-15):** Keys work in the "Click to look around" state. Panel and world keys
  (M, I, J, T, E, 1–4, R, H) are gated on `Input.inPlay` (pointer locked, or free with the hint) instead
  of the pointer lock, so a refused or lost lock, or Esc → Esc, never dead-keys them; they stay off
  while the pause menu, a panel or a notice is up. Movement (WASD, Space, C, Shift) works there too, as
  it did; mouse-look and attacks wait for the click that locks the pointer, and so does the phrase
  wheel (G), which is aimed with the mouse. Tab, `` ` ``, Shift+P and P already worked. Behind a
  loading screen (first arrival, travel, rejoin, re-warm) these keys and Tab/P wait for the hand-over
  (`Input.suspendedWhile`, set by Game), and whenever the pointer isn't locked a guard, scope or charge
  in progress is cancelled (no heavy on release or on the next lock). Why: Codex's production smoke
  test found M dead in that state, and real Chrome lands there after a refused lock.
- **D-save-1 (2026-10-15):** saving progress (HANDOFF 5b/5c, the owner's final word: guest play kept,
  email only to save). No card ever opens by itself: a guest gets a "Progress not saved · Esc → Save
  progress" toast once per tab session after the first level-up to 2+ (held while the tutorial, a
  menu or the death screen is up), plus Save progress in the Esc menu, on the death screen and on the home
  page (logging out lands there). The save card is modal and opens only with the mouse free;
  saved accounts, `?devguest` tokens and `?offline`/`?bench` runs never see any of it. The landing's
  "Sign in with email" link is a Sign in button. The level-2 rule for new addresses (D34) stays: below
  it the Esc row is disabled and the card says "Play a little first" (the tutorial pays level 2).
  Mail failures get their own answers: provider quota → `SAVING_BUSY` (503), a recipient Resend
  rejects (422) → `EMAIL_REJECTED` (400), anything else (no key, unverified domain 403, bad key,
  network) → `SAVING_UNAVAILABLE` (503). The last player-initiated send's failure holds for 10 min
  (`MailHealth`); meanwhile public sign-in requests all get the same `SAVING_UNAVAILABLE`/`SAVING_BUSY`
  (address-independent, so D34's no-enumeration holds), and `GET /api/account/save-status` reports it
  so the cards say so before the player types. Background sends to saved addresses never change it.
  `/api/account/me` gains `saveReady`, and its `character.starter` is now the starter index (as in
  PlayerState), not the stored id: a second browser stores it as `fl.starter`. The account cards mount
  on `<body>` (the landing's z 20 hid cards inside `#ui`). Why: the old level-2 card popped up mid-play
  and couldn't be clicked while the pointer was locked, the landing's sign-in card was invisible, and
  with Resend's domain unverified every save ended at a "Check your email" that never came.
- **D-save-2 (2026-10-15):** the OTP day splits into two independent pools: public sends (sign-ins
  with no session that may save) use `OTP_PUBLIC_SHARE` of `OTP_DAILY_BUDGET` (600 of 1,000), saving
  sends use the rest (400), and neither counts the other; a refused saving send says `saving`. Before,
  saving shared one global cap with public sends, which only reach saved addresses, so near the cap a
  level-2 player could probe an address publicly and read "sent" vs `SAVING_BUSY` on their own send
  (Codex review). Supersedes D34's "saving keeps the rest" (it could use idle public slots). Why: no
  enumeration oracle across paths; easy to retune the share.

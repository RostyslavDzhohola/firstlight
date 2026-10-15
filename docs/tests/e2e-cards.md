# Browser E2E cards T1–T8

The finish-line checks F3–F9 and F13 (SPEC §1, §9.3) as repeatable browser runs. Run them in T3
Code's built-in browser (D23: never the owner's Chrome), with two browser profiles when a card needs
two players. Record each run in `docs/e2e-<date>.md` with the commit, the stack (local or production),
the result per card and the screenshots. Steps, labels and keys were checked against the code on
2026-10-12; if a label differs, the code wins: fix the card.

Screenshots: `T<n>-<step>-<slug>.png`, for example `T3-4-pile-prompt.png`.

## Setup

**Local stack** (what the 2026-10-12 run used; ports chosen to avoid the defaults other lanes use):

```sh
PORT=2611 CLIENT_PORT=5611 CLIENT_ORIGIN=http://127.0.0.1:5611 BETTER_AUTH_URL=http://127.0.0.1:5611 \
API_PROXY_TARGET=http://127.0.0.1:2611 VITE_API_URL=http://127.0.0.1:2611 DEV_MAIL_LOG=1 \
AUTH_DB_PATH=/tmp/fl-e2e/auth.db GAME_DB_PATH=/tmp/fl-e2e/game.db pnpm dev
```

- Open exactly the `CLIENT_ORIGIN` host (`127.0.0.1`, not `localhost`): the sign-in cookie belongs to it.
- `GET http://127.0.0.1:2611/healthz` answers `{"ok":true,…}` when the server is up.
- Sign-in codes: with no `RESEND_API_KEY` outside production, `DEV_MAIL_LOG=1` prints
  `[dev-mail] FIRSTLIGHT code for <email>: <code>` on the server's stdout. Each address gets 3 codes
  an hour, so use a new address per run.
- **Admins** (T6): start the server with `ADMIN_CLAIM_TOKEN=<any string>`, save the character with an
  email (T5 steps 2–5), then open `http://127.0.0.1:5611/admin/claim?token=<string>` in that
  browser ("Done. <name> is now an admin."). A token works once; for a second admin restart with a
  new token, or set `is_admin = 1` for that account in game.db's `account` table and rejoin.
- Automation: the pointer lock can't be requested by automation, so force it on; combat, the hotbar
  and E only act while it is locked. `window.__game` exposes the game (`.hud`, `.net.room.state`).
- Do not use `?devguest` for T5 (it hides Save).

**Production:** `https://firstlight.one4all.dev`. T5 needs Resend's domain verified; T4 needs the TURN key.

## T1 Landing to playing in under 30 s (F3)

Fresh browser profile (cold cache), production.

1. Open `/?autoplay` (clicks Play and skips the starter pick, so the time is all loading). Screenshot
   `T1-1-loading.png` while the loading screen shows ("Loading the game…", "Connecting…", "Building
   the world…", "Warming up shaders…").
2. In-world means the loading screen is hidden (`#loading` has `hidden`) and the HUD shows: player card
   (name, Lv 1, "Safe" zone label, HP 100/100, "XP 0 / 50"), the hotbar and the "Safe zone · No damage in or
   out" banner. Read the time with `performance.now()` at that moment (time since navigation start).
   Screenshot `T1-2-in-world.png`.
3. Also run it once by hand without `?autoplay`: landing ("Firstlight", **PLAY**) → **Choose your
   starter** (Hexwick, Brother Ash, Kappa, Unit 7; palettes; a **Display name** field) → **Play as
   <starter>**. Note the time spent on the pick separately.

**Pass:** step 2 under 30 s. Also log the console's `[gfx] backend …` and `[gfx] probe → <tier>` lines.

## T2 Fighting, PvE and PvP (F4)

Two profiles, A and B, both pick **Unit 7** (starter weapon: Pocket Carbine, 9 damage per shot).

1. In Portus town, left-click: toast "Weapons are holstered in town: head out of the gates to fight"
   (the town inside its walls and 12 m around every pad are safe; D-zones-1). Outside the east or west
   gate the zone label reads Danger and Woolbacks and Hopbits are in view.
2. Walk into the **ARCADIA** portal ring on the plaza. You arrive at Arcadia's first pad.
3. **PvE:** walk more than 12 m out ("Leaving safe zone · Anyone can hurt you") into Clover Fields and
   shoot a Hopbit (22 HP at level 1, so 3 hits). Expect hit markers and "9" damage numbers, the Hopbit
   dies, the XP row rises (0 → 15 last run). Screenshot `T2-3-pve-kill.png`.
4. **PvP:** A and B both outside the ring, about 12 m apart, at least 5 s after arriving (spawn
   protection). A shoots B 3 times. Expect B's HP 100 → 73. Screenshot `T2-4-pvp-hit.png` from B.

**Pass:** the NPC dies and gives XP; B loses 9 HP per hit and nothing happens inside safe zones.

## T3 Death, then looting your own pile (F5)

One profile on Arcadia, outside the ring, carrying items.

1. Die (a Hopbit pack works). The death screen shows "You died.", "Killed by" with the killer's name,
   "Left in your pile" and "You keep", and **Rise again**. Screenshot `T3-1-death.png`.
   Expected killer name: the creature's name (e.g. "Hopbit"). Known defect (2026-10-12): the client
   doesn't map NPC kinds to names, so it shows the raw kind index ("0"); log it, it doesn't fail the card.
2. **Rise again** → "Rise again" starter screen → **Rise in Portus**. You are level 1 in Portus.
3. Go back through the ARCADIA ring to where you died (piles show within 80 m; there is no marker).
4. Within about 3 m the prompt reads **"E — take everything from <your name>'s pile"**. Screenshot
   `T3-4-pile-prompt.png`. Press E.
5. Expect the toast "Picked up N item(s) and M coins", the pile gone, the items back, and the toast
   "Medal earned: Back For My Stuff — wear the title …" (J → Medals lists it). Screenshot
   `T3-5-medal.png`.

## T4 Proximity voice and radio (F6)

**Hidden in this build (D-controls-1):** run this card only on a stack with `FEATURE_VOICE=1` on the
server and a client built with `VITE_FEATURE_VOICE=1`. Without them, check instead that the Esc menu
shows the disabled "Voice chat: coming soon" line, V does nothing and no microphone prompt appears.

Two real browsers with microphones (or Chromium's fake media flags locally), within 35 m.
Production needs the Cloudflare TURN key (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN`); without it the
voice widget says the relay is unavailable. Locally, without TURN, connections are direct.

1. Press **V**. The **PROXIMITY VOICE** panel opens with the "I'm 16 or older" checkbox; **Enable
   voice** stays disabled until it is ticked. Tick, enable, allow the microphone. Screenshot
   `T4-1-optin.png`.
2. Do the same in B. Hold **V** in A: A's widget says "Talking", B hears A and sees a speaking ring
   over A. Walk apart: the voice fades out by 35 m. Screenshot `T4-2-speaking.png`.
3. Radio: each player gets a radio (Juno Vale, Portus Exchange, 100 coins, or an admin `give radio`),
   then Esc → **Voice & radio** → the same channel (1–9). Walk far apart (or to different spots on
   the planet copy). Hold **B** in A: A's strip shows "CH n · transmitting", B hears A and sees
   "CH n · <A>". Screenshot `T4-3-radio.png`.

**Pass:** both directions audible in proximity and on the radio; nothing is sent unless V or B is held.

## T5 Email save, then the same character in a second browser (F7)

Profiles A and B, no `?devguest`.

1. A: Play, pick **Kappa** + **Moss**, name it (e.g. "Carol"), get in-world. No save card pops up.
   Reach level 2 (the tutorial pays it): a **"Progress not saved · Esc → Save progress"** toast shows
   once (`[data-e2e="save-toast"]`).
2. A: Esc → **Save progress** ("Not saved" badge, `[data-e2e="menu-save"]`; disabled below level 2)
   → **Email** → **Send code**. If it says **"Saving is temporarily unavailable"**
   (`[data-e2e="save-unavailable"]`), the server can't send mail (production: Resend's domain).
3. Read the code (local: server stdout `[dev-mail]`; production: the disposable test inbox, D6, never
   the owner's). Pasting the whole email sentence works.
4. Enter the code → **Save**. Expect **"Saved."** and **Done**; the client rejoins by itself (close
   code 4101), and the Esc menu no longer shows Save progress. Screenshot `T5-4-saved.png`.
5. B: landing → **Sign in** (`[data-e2e="signin"]`) → Send code → code → **Sign in** → "Signed in." →
   **Continue**. Play starts without a starter pick: the same Carol, Kappa, Moss, level and items.
   Screenshot `T5-5-same-character.png`.
6. A now shows **PLAYING ELSEWHERE** with **Play here instead** (close code 4100). Screenshot
   `T5-6-elsewhere.png`.

## T6 Two-player boss kill: Tidewrath (F8)

Profiles A and B, both admins (see Setup). The card checks the two-player kill flow; if you use
admin heals, write that in the results, because then it doesn't show the pair can win unassisted.

1. Both in Portus. A presses **Tab** (tap) → **Invite** next to B (needs to be within 30 m). B
   presses **Y** (Accept). The list shows "Your party (2/4)".
2. Each window opens the admin console with **Shift+`** (backquote; `` ` `` alone is the performance
   overlay) and types `level 20`, then
   `give stillshot 3` (or another tier-3 weapon).
3. A types `stage 2` (or opens A with `?stage=2&all`). The client travels to Arcadia and repeats the
   command; the party lines up on the Gull Point overlook, healed, and Tidewrath spawns at its lair on
   the lake's east shore. Toasts "Stage 2: …" and "N in scene · …". Screenshot `T6-3-staged.png`.
4. Walk down to the two **Tide Stones** on the shore (about 30 m apart). One player per stone, both
   standing on them together for 3 s: Tidewrath is **Moored** for 8 s (armour off, it kneels, the
   boss bar shows "<phase> · Moored"). Fight, re-moor when the stones light again.
5. The boss bar goes Rising → Undertow → Riptide → "Defeated". Expect "Tidewrath defeated: +120
   coins, +N items" for both and "Medal earned: Tide Turner …". Screenshot `T6-5-defeated.png`.

**Pass:** both players get the kill rewards and the medal.

## T7 Screenshot share (F9)

1. In-world, press **P**. A flash, then the **SCREENSHOT** dialog with the image and "Nothing is
   uploaded. …". Screenshot `T7-1-dialog.png`.
2. Buttons: **Copy image** and **Share…** (only when the browser supports them), **Download**
   (`firstlight-<planet>-<time>.png`), **Share on X** (opens an `x.com/intent/post` link; don't post),
   **Close** (Esc also closes).
3. Download the image and check it isn't black (the last run measured mean luminance 117).

**Fail:** the note "This browser didn't let us read the 3D view…" (blank capture).

## T8 Photo mode (F13)

1. In-world, press **Shift+P**: the HUD hides and the photo panel shows the keys (Shift+P leave, WASD · Q/E ·
   Shift fly, wheel FOV, `[ ]` focus, `- =` aperture, `, .` exposure, G filter, H hide). Screenshot
   `T8-1-panel.png`.
2. Fly the camera with WASD and the mouse (up to 180 m from your body).
3. Press **G** repeatedly: Planet → Neutral → Muted → Noir → Golden hour → Cold dawn. Screenshot
   `T8-3-filter.png`.
4. Press **Shift+P**: the panel goes, the HUD and the normal camera return.

Staged scenes for F13: `docs/staged-scenes.md`.

## T9 Onboarding and inventory (F12 follow-up)

Setup: a fresh guest (clean browser profile) on a stack with an empty database, or production.

1. Play → pick a name. The "First minute · 0 / 11" checklist (12 in builds with voice), the step rail
   and the Walk card appear.
2. Walk 6 m, move the mouse, Space, hold Shift+W, C: each step ticks.
3. Walk to the three training dummies south-east of spawn and hit each three times with the
   starter weapon (melee starters need to stand within reach). Each third hit knocks one down
   with "+10 XP"; the last pays +20, level 2 and "Medal earned: Spark".
4. Press 2 then 1 (switch weapons), E (pick up tip), M twice (map), hold G and pick a phrase
   (phrase wheel), then walk into a portal (builds with voice show an optional voice card first,
   which moves on after 8 s). The tutorial ends.
5. Press I: hotbar + 16-slot backpack, the item card and the drop zone. Click the weapon, click a
   backpack slot: the HUD hotbar shows Fists. Click it back.
6. Click the weapon, click "Drop here": a pile appears at your feet. Close with I, stand on the
   pile, press E: the weapon is back in slot 1.
7. Reload: the tutorial doesn't come back.

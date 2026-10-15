# Player expectations: the beta tester's checklist

The written checklist for the Codex beta tester (HANDOFF item 6i, D-e2e-1). After every production
deploy, Codex gpt-6.1-sol plays FIRSTLIGHT for 10–15 minutes as a first-time player and walks this
list. The Playwright journeys (`apps/client/e2e`, `pnpm e2e`) repeat the parts a script can check; this
list is for what a person notices: what's missing, confusing or ugly, not only what's broken.

**How to run it**

- `https://firstlight.one4all.dev`, a fresh browser profile (a new guest), sound muted, a normal
  window (1280×720 or larger). Never the owner's own Chrome profile.
- Play as a newcomer: don't read the code or the docs first. Pick **Hexwick** (the owner's starter)
  for the first run; rotate the other starters on later runs.
- Report in the thread: one line per checklist row (pass / fail / unsure, plus what you saw), then
  "missing or confusing" in your own words. Attach a screenshot for every fail and a short clip
  (10–20 s) for anything that moves wrong (blinking, lag, dodge, map). Name them
  `<row>-<slug>.png`, e.g. `A4-minimap.png`.
- A row marked *(J…)* also has a Playwright journey; a fail there should match a failing journey. If
  it doesn't, say so: the journey is missing something.

## A. Genre basics a player assumes

| # | Do this | Pass looks like |
|---|---|---|
| A1 | Open the site and look at the first screen. | A home page with a big **Play** button, what the game is, the worlds, who's online and a leaderboard. Buttons look like buttons (filled, hover state), not links. *(J1.1, J7)* |
| A2 | Press **Play**, pick a starter and a name, play. | In the world in under 30 s after choosing (loading text moves, never stuck). The starter you picked is the one you see, holding its weapon. *(J1.2)* |
| A3 | Look around and walk for a minute (WASD, mouse, Shift, Space). | No blinking, flashing or black frames; no freezes; the camera follows the mouse at once; nothing on the HUD flickers. *(J1.2, smoke)* |
| A4 | Look at the screen corners. | A **minimap** in a corner showing you, the terrain, nearby creatures (hostile ones red) and pads, without covering the player card, hotbar, tutorial or any card. *(J4.1)* |
| A5 | Press **M**. Find yourself, then click a spot east of you. | A readable map, north up (or a clear player-up setting). The dot you place shows on the map, as a tick with a distance on the compass (east on the compass when you clicked east), and on the minimap. Right-click clears it; walking to it clears it. *(J4.2, J4.3)* |
| A6 | Find the edge of the safe zone (walk out of Portus to a planet, then off the arrival pad). | You always know whether you're safe: a zone label on the HUD, a banner when you cross, the same answer the Esc menu gives. Attacks inside are refused with a clear "holstered" notice; outside they fire. *(J2)* |
| A7 | On a combat planet, look for something to fight. | Creatures in sight within ~20 s of arriving; the mission guide points at them; killing one gives XP you can see. *(J3)* |
| A8 | Press each key How to play lists (Esc → How to play). | Every listed key does what it says; no F1–F12 keys anywhere (MacBook F-keys are taken). *(J5.2)* |
| A9 | Press **Esc**, then **Esc** again, then click the world. | First Esc: the pause menu. Second Esc: back to the game with a "Click to look around" hint. The click looks around again without reopening the menu. *(J5.1)* |
| A10 | Dodge (**C**) while walking. | The roll starts immediately (well under a tenth of a second), not after a pause. *(J5.3)* |
| A11 | Play to level 2 as a guest. | A small toast offers saving ("Progress not saved · Esc → Save progress"); nothing pops up that needs the mouse while you're looking around. *(J6.1)* |
| A12 | Esc → **Save progress**: email → code → saved. Then open the site in a second browser and **Sign in**. | The code arrives within a minute; "Saved"; the second browser gets the same character (name, starter, level) without picking again. If email is down: a clear "Saving is temporarily unavailable", never a dead end. *(J6.2)* |
| A13 | Esc → **Log out**. | Back on the home page (leaderboard, online, worlds, my progress when saved), one click to play again. No "logged out" card over a blurred game. *(J7)* |
| A14 | Listen for a minute (unmute briefly if allowed). | No annoying repeated "ping"; weapons sound like what they are. |
| A15 | Watch for broken or placeholder art. | Characters look like 3D characters (not flat 2D portraits); no missing textures, pink materials or floating props. |

## B. Every owner report so far (HANDOFF.md)

Each fix counts as done only when its row (and its journey, if any) passes.

| Item | The owner said | Do this | Pass looks like |
|---|---|---|---|
| 1 | "Still blinking", "like lagging" (real Chrome, recording 2026-10-14). | Play 2 minutes: walk the Portus plaza, open and close the Esc menu and the map, cross into Arcadia, fight. Record a clip. | No one-frame flashes or dark frames, no stutter clusters, no HUD callout flicker. Note the browser, display (ProMotion?), fullscreen or not. *(J1.2, smoke)* |
| 2 | "Weapons work in the safe zone but not outside — reversed." | As **Hexwick** with Hexquill I: attack on the Portus plaza (away from the training dummies), on each planet's arrival pad, and outside the pad ring on Arcadia, Hollowmere and Meridian. Repeat with one other starter. | Inside: nothing fires, "Weapons are holstered in safe zones". Outside: the spell fires and hurts things. The HUD zone label agrees each time. *(J2.1–J2.8)* |
| 3 | "No creeps outside." | Arrive on each planet; stand on the pad and turn around once, then walk out for 20 s. | Creatures within sight on every planet; at least one hostile you can reach and fight. *(J3.1–J3.3)* |
| 4 | Dodge roll "takes a second before it rolls". | Press **C** standing and while running, several times. | The roll starts at once every time. *(J5.3)* |
| 5a | Email sign-in doesn't work (Resend domain not verified). | Save progress with a real disposable inbox (D6), never the owner's. | The code email arrives; saving works. *(J6.2 locally)* |
| 5b | "Sign in with email" is a link. | Look at the home/landing page. | A real **Sign in** button. *(J6.2, J7.1)* |
| 5c | Guests play free; ask for email only to save, at natural moments; never a card while the pointer is locked; saved players never see prompts. | Play as a guest to level 2, die once, log out; then save and repeat. | Toast after the first level-up, "Save progress" in Esc, a line on the death screen and at log-out, a note that guest progress lives in this browser. After saving: no prompts at all. *(J6.1, J6.2)* |
| 6 | Hide voice and radio: "coming soon". | Look at the HUD, press **V** and **B**, open Esc, the shop and the inventory. | No voice pill, no mic prompt, no radio item; Esc shows "Voice chat: coming soon". *(J5.4)* |
| 6a | Log out → a real main page (leaderboard, online, worlds, my progress). | Log out as a guest and as a saved player. | The home page with real numbers and names, the worlds with level ranges and bosses, my progress when saved. *(J7.1, J7.2)* |
| 6b | "The map is inverted. I cannot put a dot where to go. There's no minimap." | Rows A4 and A5. | Map and compass agree; waypoint works; minimap present and clear of the HUD. *(J4)* |
| 6c | "Where are all the creeps outside? Let's see the creeps." | Row A7 on Arcadia first. | Creatures visible within ~20 s of arriving; the first mission points at them; they show on the minimap. *(J3)* |
| 6d | "No F-key shortcuts", "Esc should bring you back into the game". | Rows A8 and A9; also try photo mode and the performance overlay from their new keys. | Every action has a non-F key that works; Esc resumes. *(J5.1, J5.2)* |
| 6e | Share buttons like littleprince.dev (share, email, follow on X). | Find the share row on the home page and in Esc. Try Share and Email (don't post). | Share opens the system share sheet or copies the link with a toast; Email opens a mail draft with a short invite; Follow on X only if the owner gave a handle. |
| 6f | DataFast: "Online now: N · Total visits: M" on the home page. | Look at the home page. | The card shows plausible numbers (not 0 / blank / an error); the page notes cookies if DataFast uses them. |
| 6g | Graphics: lusher grass, softer sky and clouds, a less flat character (study, don't rebuild). | Compare a screenshot of Arcadia's arrival with the owner's references (littleprince.dev). | Report what still looks flat or bare; no regressions in frame rate (A3). |
| 6h | A 5th starter: an original ninja with a fire technique. | When it ships: pick it, use its weapon and the fire technique outside a safe zone. | An original look (no franchise names or marks), a hand-seal wind-up then a fireball that explodes. |
| 7 | The 2D portraits on the character screen are "hilarious"; expected real 3D characters. | Open the starter pick and look at your character in game. | Real 3D characters on the pick screen and in the world. |
| 8 | Replace the annoying "ping"; better weapon and UI sounds. | Play with sound for a minute (muted runs: note it untested). | No grating ping; a sword swish, magical sounds for the wand and spells. |
| 10 | The tutorial's end card timer includes loading time. | Finish the tutorial and walk through a portal. | The end card stays its full time after you arrive, not while loading. |

## Missing or confusing (free text)

After the rows, write what a newcomer would wonder about: what to do next, where to go, what a button
does, what a number means, anything that looked like a button but wasn't (or the other way round).

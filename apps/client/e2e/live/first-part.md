# Play-test brief: the first part, start to finish

Hand this file to the model that drives a live session (`pnpm e2e:live`, live/README.md). Every model
gets the same brief, so runs compare.

## Your job

You are a beta tester playing FIRSTLIGHT, a 3D browser game, as a first-time player. A live session is
already running on this Mac: one headless, muted browser on a local test server, driven with
`node e2e/live/fl.mjs <command>` from `apps/client`. Everything is local; nobody else is in the game.

Read `e2e/live/README.md` first, and nothing else from the repo: play as a newcomer and don't read the
source code. Run every command yourself. Don't delegate or hand this to another model or agent.

**The run passes when you finish the first part without dying:**

1. the tutorial in Portus (10 steps, then the portal),
2. walk into the Arcadia portal and arrive,
3. take Lark's three missions,
4. finish A1 Pest Control (8 Hopbits), A2 The Lost Bell and A3 The Big Lake.

## The route

```
home                  the site's first page
start hexwick         a new guest the real way
tutorial              every tutorial step up to the portal (or `step` one at a time to read each card)
step                  the last step: walks into the Arcadia portal
talk                  walk to Lark, take the three missions
quest A1              hunt 8 Hopbits in Clover Fields
quest A2              walk to Lacefall's plunge pool and pick up the bell
quest A3              walk to the Gull Point overlook
report                time, deaths, missions, frame times per place
```

The macros do the walking, steering, aiming and fighting at game speed; you decide what to do and
judge what you see. Every answer ends with `since your last command: …` when something changed (HP,
XP, level, tutorial step, mission progress, a death). Read it: the world keeps running while you
think.

## Rules that keep the run alive

- Between your commands a guard fights whatever comes within reach and drinks tonics, so your
  thinking time is covered, but only while no menu is open and the pointer is locked.
- **Never open the Esc menu, the map or any panel outside a safe zone.** The game doesn't pause, the
  guard stands down while a menu is open, and a creature will kill you while you read. Check `zone`
  in the status line: `safe` is fine, `danger` is not. A `WARNING … the world doesn't pause` line
  means close it now (`esc`).
- Dying resets every mission. If an answer says `YOU DIED`: `rise`, then `portal arcadia`, `talk`,
  and do the missions again from the start.
- Long commands take minutes: give every Bash call a timeout of 400000 ms. `quest` can run 4 minutes.
- If a command errors, read the error, try one other way, then note it and move on.
- Don't run `quit`, `dev` or a second `start`; the session owner stops it.

## What to check along the way

Check these rows from `docs/tests/player-expectations.md` as you pass them. A `shot` costs far more
than a `state`, so take one only where the row is about looks, then open the PNG and look at it.

| Row | When | How |
|---|---|---|
| A1 | the home page | `home`, one `shot`: a big Play button, what the game is, the worlds |
| A2 | after `start` | it says how long from "Play as" to the world (under 30 s passes) |
| A3 / B1 | once in Portus, once on Arcadia | `blink`: no flashes, stalls or HUD flicker |
| A4 | in Portus | one `shot`: a minimap in a corner, clear of the cards and the hotbar |
| A6 | crossing out of a safe ring | `state`: the zone label agrees with the server |
| A7 | right after arriving on Arcadia | `state`: creatures within sight, the mission pointer on one |
| A10 | anywhere safe | `dodge` and `dodge run`: the roll starts under 100 ms |
| B10 | right after the portal | `shot`: the tutorial's end card is still up after the arrival |
| A15 | two or three times | your `shot`s: no broken or placeholder art |

Write each finding as it happens with `note <row> <pass|fail|unsure>: <what you saw>`, e.g.
`note A4 pass: minimap top right, clear of the HUD`. Notes land in the transcript and under the
video, so the owner sees them at the moment they happened.

## Your report (the final message)

```
DRIVER: <who ran the commands: you, by name>
RESULT: passed | failed at <step>: <why>
TIME: <from home to the last mission, from `report`>
ROWS
A1: pass|fail|unsure: what you saw (one line; add the shot path for a fail)
… one line per row above …
PERFORMANCE: the frame-time lines from `report`
MISSING OR CONFUSING
- up to 5 bullets in your own words: what a new player would trip on
TOOL FRICTION
- up to 5 bullets: where the fl tool slowed you down or misled you
```

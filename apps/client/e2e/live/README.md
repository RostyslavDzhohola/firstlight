# Live play sessions

One headless, muted browser stays in the game while a model or a person plays it one command at a time.
Each answer is a few lines of text taken from the test hook (`window.__fl`), not a screenshot, so a
small, cheap model can play-test. It runs on the journeys' stack and uses their fixtures and `Player`
(`../player.ts`), so the owner rules still hold: headless and muted, checked before the page loads, and
test guests flagged.

## Start and stop

```sh
pnpm e2e:live                          # local stack on :2602/:5202, WebGL; run it in the background
apps/client/e2e/live/fl.mjs ready      # waits until the session answers (about 15 s, longer on a cold build)
apps/client/e2e/live/fl.mjs help       # every command
apps/client/e2e/live/fl.mjs quit       # ends it; so do 20 idle minutes (FL_LIVE_IDLE_MIN)
```

- `E2E_GFX=webgpu` runs installed Chrome on WebGPU. `E2E_TARGET=prod` plays https://firstlight.one4all.dev
  with a flagged test guest, like `pnpm e2e:prod`; it needs `LOADTEST_SECRET`.
- Production play is read-only like `pnpm e2e:prod`: `attack`, `fight`, `dev`, `save` and the
  first-part macros (`step`, `tutorial`, `talk`, `quest`) are refused there and the guard is off,
  because every other player is a real person and a stray bolt or chain is PvP.
- Ports: `E2E_PORT` / `E2E_CLIENT_PORT` (default 2602/5202, so a session can run next to `pnpm e2e`)
  and `FL_LIVE_PORT` (the command port, default 7357).
- Evidence goes to `$E2E_OUT/live/` (default `apps/client/e2e/.out/session/live/`): `transcript.log`
  (every command with its time and the first line of its answer), `shots/`, `perf.jsonl` (frame
  times every 5 s, with the body and whether the world was up), `report.txt` and `video.mp4`.
- **The session films its page.** On `quit` the film becomes `video.mp4`: the game on top and a strip
  under it with the driver (`FL_LIVE_DRIVER`, e.g. `FL_LIVE_DRIVER="Haiku 5.5"`), the clock, the
  command running or its answer, and the thinking time before the next command. It is cut from just
  before the first command to just after the last. Wait for the session process to exit before
  opening it (encoding takes a minute or two). `FL_LIVE_VIDEO=0` turns filming off, for frame-time
  runs that shouldn't pay for it.
- A session is one player. Use `start` (a new guest, the real Play flow) or `dev <body>` (local only:
  an admin guest placed on a planet), not both. Quit and start a new session for another player.

## Playing it well (for models)

- Run `fl.mjs state` after anything that matters. It shows the zone and label, you (level, HP, XP),
  the weapon, the tutorial step, hostiles with their distance and direction, the pad, guide, portals,
  gates, the menus and HUD parts on screen, and recent toasts.
- Use the macros before stepping by hand: `start`, `tutorial`, `step`, `talk`, `quest`, `rise`, `out`,
  `portal <body>`, `walk <target>`, `fight`, `train`, `blink`. Use `key`, `turn`, `clickxy` and `eval`
  only when a check needs that one input.
- Every answer ends with `since your last command: …` when something changed in between (HP, XP,
  level, tutorial step, mission progress, a death, a new body). The world runs while you think: a
  `WARNING` there means a menu is open outside a safe zone with a creature near. Close it (`esc`).
- **The guard.** Between your commands the harness keeps the character alive the way a player's hands
  would: it drinks a tonic below 45% HP, runs for the pad below half HP with no tonic ready, and
  fights a hostile within reach (15 m with a ranged weapon, 8 m with a melee one, never a boss)
  outside the safe zones. It does nothing while a menu or panel is open, while
  the pointer is free, or on production (read-only there). What it did shows in the next answer
  (`the guard fought 2 Hopbit while you were thinking`). `guard off` stops it.
- `note <text>` writes a finding into the transcript and the video strip at that moment.
- `trace.log` has the macros' own decisions with their timing (each walk, fight beat, kite, held
  fire): read it when a `quest` or `fight` went wrong.
- `report` sums the run up: time (game busy vs driver thinking), deaths, tutorial and missions, and
  frame times per body from the 5 s samples.
- Take a `shot` only when the question is about looks (art, HUD overlap, a menu's layout, something
  the state can't say), then open the PNG it prints. Each image costs far more than a state read.
- `screen` gives the page text and every visible button. `click <text>` presses a button by its label.
- Anything about timing under a second (the dodge roll, a flash) is measured inside the page:
  `dodge`, `blink`, `perf`. A CLI round trip takes too long to judge 100 ms.
- Headless Chrome lets the game take the pointer back without a click, so after Esc closes the menu
  the "Click to look around" hint doesn't show. `esc` says when that happened.
- Movement commands lock the pointer first and say so. `key` doesn't, because some checks need the
  pointer free; it warns instead.
- Long commands wait for the game. `start`, `portal` and a cold `world` can take up to 3 minutes,
  so give your shell call a long timeout.

## The first part, start to finish

`tutorial` (every step up to the portal; `step` does one and reads its card), `step` again for the
portal, `talk` (Lark's three missions), then `quest A1`, `quest A2`, `quest A3`. A hunt (A1) fights
what the mission pointer marks and anything hostile within reach (15 m with a ranged weapon, 8 m with
a melee one). A find (A2) or a reach (A3) sprints past creatures to the objective (a sprint outruns
them, and every fight on the way costs HP nothing heals back but tonics and level-ups), presses E at
the bell, and gets clear of creatures when it's done. Every quest drinks a tonic below 45% HP, runs
for the pad below half HP with no tonic ready, routes 55 m round a boss, and stops after 150 s
without progress, because dying resets every mission.

## A play-test brief

`first-part.md` is the brief for a model playing the first part start to finish: the route, the
rules that keep the run alive, the rows to check on the way and the report's shape. For a checklist
pass instead, hand the model `docs/tests/player-expectations.md` and this file. Either way it reports
one line per row (pass / fail / unsure, plus what it saw) with the shot path for every fail. When a
row has a journey *(J…)* that passes while the model saw a failure, the journey is missing something.

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
  with a flagged test guest, like `pnpm e2e:prod`; it needs `LOADTEST_SECRET`, and `dev` and `save`
  are refused there.
- Ports: `E2E_PORT` / `E2E_CLIENT_PORT` (default 2602/5202, so a session can run next to `pnpm e2e`)
  and `FL_LIVE_PORT` (the command port, default 7357).
- Evidence goes to `$E2E_OUT/live/` (default `apps/client/e2e/.out/session/live/`): `transcript.log`
  (every command with its time and the first line of its answer) and `shots/`.
- A session is one player. Use `start` (a new guest, the real Play flow) or `dev <body>` (local only:
  an admin guest placed on a planet), not both. Quit and start a new session for another player.

## Playing it well (for models)

- Run `fl.mjs state` after anything that matters. It shows the zone and label, you (level, HP, XP),
  the weapon, the tutorial step, hostiles with their distance and direction, the pad, guide, portals,
  gates, the menus and HUD parts on screen, and recent toasts.
- Use the macros before stepping by hand: `start`, `out`, `portal <body>`, `walk <target>`, `fight`,
  `train`, `blink`. Use `key`, `turn`, `clickxy` and `eval` only when a check needs that one input.
- Take a `shot` only when the question is about looks (art, HUD overlap, a menu's layout, something
  the state can't say), then open the PNG it prints. Each image costs far more than a state read.
- `screen` gives the page text and every visible button. `click <text>` presses a button by its label.
- Movement commands lock the pointer first and say so. `key` doesn't, because some checks need the
  pointer free; it warns instead.
- Long commands wait for the game. `start`, `portal` and a cold `world` can take up to 3 minutes,
  so give your shell call a long timeout.

## A play-test brief

Hand the model `docs/tests/player-expectations.md` (the rows to walk) and this file. It reports one
line per row (pass / fail / unsure, plus what it saw) with the shot path for every fail. When a row
has a journey *(J…)* that passes while the model saw a failure, the journey is missing something.

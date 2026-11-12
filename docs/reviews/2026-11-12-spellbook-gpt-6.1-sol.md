# The spellbook (lane/spells) — review round 1 (Codex gpt-6.1-sol)

Scope: `2aeff01a..lane/spells` at `225cab57`. Static review, reasoning effort high, Standard tier; no
tests run. No blockers.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | should-fix | `apps/server/src/world/spells/SpellSystem.ts:225` (props at `:244`) | Frostbloom checks walls but never checks or charges Prism Bubble shells (`dealDamage` doesn't intercept bubbles): the nova damages and slows through a bubble without spending its shield. |
| 2 | should-fix | `SpellSystem.ts:272` | Wishfall clamps the unsnapped point to 30 m, then projects it onto terrain without re-checking the distance: on slopes or from height the impact can land past the range (the test allows 3 m extra and has no elevation case). |
| 3 | should-fix | `SpellSystem.ts:285` | After an obstruction the shortened ray point is snapped to the ground without tracing to the final point again: under a roof or raised solid the impact can land beneath it. |
| 4 | should-fix | `SpellSystem.ts:236` | Frostbloom always sends its requested slow even when `applyMoveEffect` ignores it for a stronger active one; the client keeps every effect, so predicted movement and server limits disagree. |
| 5 | should-fix | `apps/client/src/game/spellBook.ts:88` | Each prediction overwrites the single rollback snapshot: two casts refused in a row (Q and F under arrival protection) leave phantom aether and cooldown until the next snapshot. |
| 6 | nit | `apps/client/src/render/spellFx.ts:447`, `:524` | Wishfall allocates nested arrays and iterators every frame; `update` builds a pool-list array every frame. |

Verdict: request changes. Decisions and fixes are recorded below this line as they land.

## Fixes

All six accepted. Each commit carries a test that failed on the code before it.

| # | Fix | Commit | Test (failed before) |
|---|---|---|---|
| 1 | Frostbloom goes through the splash-shield path: sheltered actors and props are collected first, each shell in the way pays the nova's flat damage once | `85fec9b3` | `apps/server/test/spells.test.ts`: "a Prism Bubble shell shelters whoever stands behind it…", "a crate inside a Prism Bubble is sheltered…" |
| 2 | The landing point is searched back toward the caster until the ground point itself is within 30 m of the feet (0.5 m steps, then the edge of the range to under a centimetre). No ground in range refuses the cast (`blocked`, nothing spent) | `3c80c8ba` | `spells.test.ts`: "the 30 m range holds for the ground point the star lands on: from a height and down a steep slope" (before: 30.9 m from 15 m up, 34.9 m down the slope); the older far-target test lost its 3 m of slack |
| 3 | Every candidate point is traced itself: head → chest height over the point → where the blast goes off, against ground, structures and intact props. No clear ground refuses the cast | `ed75a2e0` | `spells.test.ts`: "never lands inside or under a raised solid…" (a caster 15 m up beside the Portus castle-ward wall; before: the star landed inside the wall) |
| 4 | The server sends the slow it holds after the cast (amount, time left) with `set`; the client replaces the slows and chills it was predicting (`apps/client/src/world/npcs/moveEffects.ts`) | `856d4009` | `spells.test.ts`: "tells a slowed player the slow the server holds for them…"; `apps/client/src/world/npcs/moveEffects.test.ts` |
| 5 | Casts are numbered (`cast.req`, echoed in `denied.req` and `you.spells.req`); the client shows the server's state with every unanswered cast on top and takes back exactly the one a refusal names | `6ac225a5` | `apps/client/src/game/spellBook.test.ts`: "two casts in a row, both refused…" and three more; `spells.test.ts`: "numbered casts are answered by number…" |
| 6 | The pools are listed once and walked by index; the star's beams are placed by name; its sparks share one options object | `90ab7d02` | `apps/client/src/render/spellFx.test.ts`: "…animated without making arrays or iterators" (before: 366 array iterators in 40 frames) |

Notes for the next reviewer:
- Fix 3 traces from the caster's head, so a star still can't be called onto the top of a raised structure (the
  point is put on the terrain under it and pulled back to the structure's foot), and a spot under a roof that the
  caster can see into from the side is still a valid landing point.
- Fix 4 covers Frostbloom only. Creatures' slows (`NpcSystem.applyEffect`) still send the requested effect; the
  client's max-of-all rule matches the server there except after a stronger slow replaces a longer weaker one.
- Fix 5's fields are optional both ways, so `PROTOCOL_VERSION` stays as it is.

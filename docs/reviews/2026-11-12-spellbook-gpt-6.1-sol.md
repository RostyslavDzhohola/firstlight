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

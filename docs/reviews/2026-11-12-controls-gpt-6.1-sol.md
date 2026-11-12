# Gamepad and touch controls (lane/controls) — review round 1 (Codex gpt-6.1-sol)

Scope: `c5547f5b...6b1ae3b5`. Static review, reasoning effort high, Standard tier; no tests run. No blockers.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | should-fix | `apps/client/src/game/input.ts:35` | `capturedFrom()` ignores window focus and document visibility; blur clears keyboard keys only, so an unfocused game keeps moving, firing or charging from the pad. |
| 2 | should-fix | `apps/client/src/game/gamepad.ts:107` | Disconnect releases held keys only when no pad remains; `held` records a button without its pad. Unplugging pad A while B stays leaves A's keys (sprint) held. |
| 3 | should-fix | `gamepad.ts:251` | Disconnect cleanup turns `alt` off like a release: unplugging mid-charge reaches combat's release branch and can launch the heavy attack. |
| 4 | should-fix | `input.ts:98` | Physical and virtual keys share one set and every keyup deletes the code: a pad's synthetic Shift keyup cancels a held keyboard sprint. |
| 5 | should-fix | `gamepad.ts:55` | Triggers use one 0.35 threshold with no hysteresis: noise near it flutters attack or alt. |
| 6 | should-fix | `gamepad.ts:115` | Pad look caps elapsed time at 100 ms while the game advances frames up to 250 ms: at 200 ms frames the stick turns at half speed. |
| 7 | should-fix | `apps/client/src/ui/touch.css:49` | `touch-action: none` sits on the document and body for good, menus included: long Settings and panels can't be scrolled by finger. |
| 8 | should-fix | `apps/client/src/ui/touchOverlay.ts:213` | `fl-touchmode` stays set after a switch to mouse or pad while the overlay hides; its CSS still hides the normal spell bar, so neither shows. |
| 9 | should-fix | `apps/client/src/game/controls.ts:128` | Aim slowdown tests creature centres along the ray without world occlusion or nearer players: a creep behind a wall or behind an opposing player still slows the aim (against D-controls-5). |
| 10 | should-fix | `apps/client/e2e/jpad-touch.spec.ts:111` | The Settings navigation assertion runs only if focus reached Settings, and the test scrolls with Playwright: broken pad navigation can pass. |
| 11 | nit | `gamepad.ts:119` | Per-frame allocations and repeated `getGamepads()` snapshots in the polling path. |

Verdict: hold for the should-fix findings. Decisions and fixes are recorded below this line as they land.

## Fixes (lane/controls, Claude Opus 5.5)

Each test fails on the code before its fix and passes after (checked by putting the old source back), except where noted.

| # | Fix | Commit | Test |
|---|---|---|---|
| 4 | Held keys tracked per source (keyboard, `pad:<index>`, touch, menu rows); `keys` is their union; a keyup releases only its sender's hold | `519321aa`, `6315966a` | `gamepad.test.ts` › "Input: held keys per source (review #4)" |
| 2 | Per-pad ownership of keys, sprint latch, Select and Input sources; unplugging one pad releases only its own | `86bfdd1f` | `gamepad.test.ts` › "two pads, one unplugged (review #2)" |
| 3 | Unplug cancels alt (`Input.cancelButtons` → `altCancelled`); `CombatClient` drops the charge, draw or guard on it instead of releasing | `cde4ae5e` | `gamepad.test.ts` › "unplugged mid-charge (review #3)" (no `CombatClient` unit test exists; the combat side is the one-line drop) |
| 1 | `Input.focused` follows blur/focus and `visibilitychange`; losing it clears every source at once; `capturedFrom` needs it; the pad stops polling into the world and each pad must return to neutral; a key held through it doesn't auto-repeat back in; touch lets go of its pointers | `391018be` | `gamepad.test.ts` › "Focus and visibility (review #1)" |
| 5 | Trigger hysteresis: press above 0.35, let go below 0.2 | `b65e2254` | `gamepad.test.ts` › "Trigger hysteresis (review #5)" |
| 6 | The pad sets a look rate; `Game.frame` integrates it with `frameClock`'s dt (`Input.integrateLook`), so 200 ms frames turn twice as far as 100 ms ones | `fc1935e0` | `gamepad.test.ts` › "Pad look and the frame clock (review #6)" |
| 8 | `fl-touchmode` follows the active device | `4fe7d4a3` | `touchOverlay.test.ts` › "fl-touchmode follows the active device (review #8)" |
| 7 | `touch-action: none` only on the overlay, its buttons, the game canvas (`fl-game-canvas`) and hotbar slots; not on the document or body | `019ea8bd` | `touchOverlay.test.ts` › "touch.css: touch-action only on gameplay surfaces (review #7)" |
| 9 | `SpellClient.crosshairPoint`'s query moves to `game/crosshairTarget.ts` and reports what it hit; the slowdown counts only an unobstructed nearest creature, and runs the query only while the right stick turns (once per poll) | `42b3eb60` | `crosshairTarget.test.ts` (new module, so it fails before by construction) |
| 10 | Journey asserts pad focus reaches Settings, opens it unconditionally, scrolls it with the right stick and checks `scrollTop` grew | `711e96ce` | `e2e/jpad-touch.spec.ts` (typechecked, **not run**: the machine was loaded) |
| 11 | One `getGamepads()` snapshot per poll; reused snapshot, edge pool and per-pad button buffers | `54c1a3ff`, `640368b6` | `gamepad.test.ts` › "Polling path allocations (review #11)" |

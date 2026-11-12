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

# Hub graphics (lane/gfx-hub) and the bug sweep (lane/fixes) — review round 1 (Codex gpt-6.1-sol)

Scope: `62da084d...lane/gfx-hub` at `1d2da6de` and `62da084d...lane/fixes` at `bd4ad761`. Static review,
reasoning effort high, Standard tier; no tests run. No blockers in either lane.

## A. Hub graphics

| # | Severity | Where | Finding |
|---|---|---|---|
| A1 | should-fix | `apps/client/src/game/Game.ts:832` | Every newly seen remote starts a rez-in at once, including the whole room on the first or a reconnect snapshot: 40 players = 40 additive effect draws (56 shards, rings and a column each) in the same frames. No concurrency, distance or arrival-age gate. |
| A2 | should-fix | `apps/client/src/render/Avatars.ts:355`; `game/Game.ts:181` | Turning Rez off only flips `rezSwitch.on`; running effects keep stepping, drawing and writing uniforms until they end. |
| A3 | should-fix | `apps/client/src/world/HoloBoard.ts:249–254` | The refresh runs before the visibility guard: `?noholo` and the Holo toggle still fetch `/api/home` on arrival and every four minutes, parse, redraw and upload. |
| A4 | should-fix | `HoloBoard.ts:81` | Names are cut by character count but drawn without a measured width limit or clip: sixteen wide characters overlap the value column and the next page. |
| A5 | nit | `apps/client/src/world/holoBoardModel.ts:101`; `HoloBoard.ts:256` | `holoPageAt()` returns a new object every visible frame. |

### Fixes (lane/gfx-hub, second pass)

| Finding | Commit | Fix | Test |
|---|---|---|---|
| A1 | `9203eb33` | `Net` marks every player of the join or reconnect snapshot `seeded`: they are simply there. An effect needs one of 6 slots (`REZ_MAX_ACTIVE`) and to be within 90 m of the camera (`rezAdmits`; the player's own always runs); a frame's arrivals take the slots nearest first (`AvatarView.rezArrivals`). Without a slot an arrival is whole at once, a departure is freed at once, a death dissolves the body without its light. | `apps/client/src/net/Net.test.ts` "Net remotes: who was already there"; `apps/client/src/render/rezGate.test.ts` "rezAdmits", "arrivals" (forty at once → six effects, the nearest) |
| A2 | `b5b02991` | `AvatarView.settleRez()` runs when the resolved Rez setting changes: off, every effect ends now (bodies whole, the dead lying where they fell as with Rez off, lights hidden, slots free) and the avatars mid de-rez are freed; on again, the dead are gone until they rise. | `apps/client/src/render/rezGate.test.ts` "the Rez switch" |
| A3 | `708fee35` | The request moved into `world/holoFeed.ts`, which follows the board's resolved state (`settings.on.holo`, not offline): off, no request and the one under way is aborted; on again, it asks at once if its data is older than the interval; dispose aborts. | `apps/client/src/world/holoFeed.test.ts` |
| A4 | `c32817b9` | `world/holoBoardDraw.ts`: a row measures its value first, the name gets the rest, cut by `measureText()` between whole characters and clipped to its rectangle (the note too); a value takes at most half a row; each page is clipped to its half of the canvas. `cleanText()` strips C0/C1 controls and the bidirectional marks, embeddings, overrides and isolates from names, titles and the hunt's lines. | `apps/client/src/world/holoBoardDraw.test.ts` |
| A5 | `7f74cd7d` | `holoPageAt()` takes an `out` object; the board keeps one. | `apps/client/src/world/holoBoardModel.test.ts` "holoPageAt per frame" |

## B. Bug sweep

| # | Severity | Where | Finding |
|---|---|---|---|
| B1 | should-fix | `apps/server/src/world/onboarding.ts:115` | Resuming the tutorial after a rebirth keeps the paid dummy flags, but the rebirth makes a character with 0 XP: after one paid dummy and a death, finishing pays only 40 XP (level 2 needs 50), so the tutorial completes for good with saving still locked, the very outcome D-fixes-2 set out to restore. The death test never finishes training. |
| B2 | should-fix | `apps/client/src/game/PlayerController.ts:576` | The camera's shoulder switch advances a fixed 0.08 per rendered frame: 0.42 s at 60 fps, 6.25 s at 4 fps, with further shoulder decisions held until it settles. |

Verdict (both): request changes. Decisions and fixes are recorded below this line as they land.

### Fixes

| Finding | Commit | Test (fails before the fix) |
|---|---|---|
| B1: a reborn trainee finishes at 40 XP, level 1, saving locked | `2e25a3ba` (D-fixes-4: the completion tops a level-1 character up to the tutorial's 50 XP; once per account, so no farming) | `apps/server/test/onboarding.test.ts` "dying mid-tutorial (D-fixes-2)": now runs on through completion and asserts 50 XP, level ≥ `OTP_MIN_LEVEL`, the done flag, and that a second death brings back neither the tutorial nor XP (timed out at "level 2" before); `completionXp` unit test |
| B2: the shoulder swap moves 0.08 per frame (6.25 s at 4 fps) | `d2527cd5` (D-fixes-5: `placeCamera(camera, dt)`, swap 4.8 units/s, lens ease-out 15 m/s, `easeShare` for every `min(1, k·dt)` smoothing) | `apps/client/src/game/PlayerController.test.ts` "the camera and the controller ease by time, not by frames (review B2)": swap there and back as a side wall comes and goes, and the ease-out after a wall behind goes, each at 4 and 60 fps (the 4 fps cases failed before); running and turning alike at 4 and 60 fps; `frameClock.test.ts` "easeShare" |

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

## B. Bug sweep

| # | Severity | Where | Finding |
|---|---|---|---|
| B1 | should-fix | `apps/server/src/world/onboarding.ts:115` | Resuming the tutorial after a rebirth keeps the paid dummy flags, but the rebirth makes a character with 0 XP: after one paid dummy and a death, finishing pays only 40 XP (level 2 needs 50), so the tutorial completes for good with saving still locked, the very outcome D-fixes-2 set out to restore. The death test never finishes training. |
| B2 | should-fix | `apps/client/src/game/PlayerController.ts:576` | The camera's shoulder switch advances a fixed 0.08 per rendered frame: 0.42 s at 60 fps, 6.25 s at 4 fps, with further shoulder decisions held until it settles. |

Verdict (both): request changes. Decisions and fixes are recorded below this line as they land.

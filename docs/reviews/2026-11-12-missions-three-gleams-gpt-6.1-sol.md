# Missions and the Three Gleams hunt (lane/missions) — review round 1 (Codex gpt-6.1-sol)

Scope: `2aeff01a..lane/missions` at `8d917803` (race, defend and collect objectives, the Three Gleams,
the vault, two regular missions, client markers and clock, automation hooks). Static review, reasoning
effort high, Standard tier; no tests run. No blockers.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | should-fix | `apps/server/src/world/quests/trials.ts:116` | Attempts end on the system's leave hook, but a dropped socket keeps the actor for the 30 s reconnection window and `onReconnect` calls neither trial hook: a dropped defender keeps accumulating hold time and can finish while disconnected (against D-hunt-3); the waves stay active. |
| 2 | should-fix | `trials.ts:340` | A wave's `userId` is metadata only: perception picks any nearby player, retaliation can switch targets and attack shapes hit bystanders. A trial can unleash unpaid enemies on strangers, and another player can draw the waves away. |
| 3 | should-fix | `trials.ts:252` | Collect completion removes the run and sends `done` before the reward transaction succeeds. A failed save rolls back with every piece flagged but `m.done === false`, and later ticks return early: the mission stalls until abandoned while the client has announced success. |
| 4 | should-fix | `apps/client/src/game/trialState.ts:23` | The previous room's message listener stays registered and can overwrite the module-global `latest` after another room starts listening (travel, reconnect). |
| 5 | should-fix | `trialState.ts:53` | The clock counts from receipt, but `leftMs` was computed at send time and the protocol carries no timestamp: the HUD overstates the time left by the delivery delay and jumps on updates. |
| 6 | should-fix | `apps/server/test/trials.test.ts:121`, `:269` | The "pay nothing" test never kills a wave or checks reward deltas; the rebirth test ("vault opens again; the medal stays") never opens the vault or checks the medal. |
| 7 | nit | `apps/client/src/world/TrialMarkers.ts:131`, `:178`, `:204` | Per-frame allocations: a map and mission wrappers, two quaternions per visible beacon, one per shard. |

Verdict: changes requested. Decisions and fixes are recorded below this line as they land.

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

## Fixes (2026-11-12, lane/missions round 2, Claude Opus 5.5)

Each fix landed with a test that fails on the code before it.

| # | Fix | Commit | Test |
|---|---|---|---|
| 1 | New optional `RoomSystem.onPlayerDrop` / `onPlayerReconnect` (called from `BodyRoom.onDrop` / `onReconnect`). A drop resets the attempt and dissolves its waves. Lingering bodies run no trial. The reconnect hears `idle` with reason `dropped`. | `95ed8a87` | `trials.test.ts` "a dropped socket ends the attempt at once…" (a real socket close with code 3000, then a token reconnect with a fresh client) |
| 2 | `NpcSystem.ownerOf` / `mayEngage`, enforced in perception (the owner only, sensed within `NPC_TUNING.ownedSenseM` = 60 m through cover, so the wave comes for you), aggro, retaliation, pack sharing, `hitPlayer` and `mitigate` | `0fd89255` | "waves belong to their runner…" (a bystander beside the beacon: never targeted, never hurt, their hits refused) |
| 3 | `completeMission` returns whether it paid. `trials.finish` pays first, then ends the attempt and sends `done`. A failed save marks the attempt complete (the clock stops) and the payout retries each tick. | `9abe5cd5` | "the last shard pays before it says done; a failed save keeps the completion pending…" |
| 4 | `listenTrials` removes the previous room's handler and guards each handler by a generation number | `236a450b` | `trialState.test.ts` "an old room delivering late can't overwrite…" |
| 5 | Optional `TrialMsg.endsAt` (additive): the server's deadline. The client stamps messages on the synced server clock (`trialNow()`) and counts down to it. | `8ca5fc82` | `trialState.test.ts` "the clock runs to the server's deadline…" (a 2 s late delivery) and the `endsAt` check in the first race test |
| 6 | "Pay nothing" now kills a wave creature and checks XP, coins, piles, kill events and hunt counts, with an ordinary Bonewalker as the control. The rebirth test now opens the vault, dies and is reborn, checks the medal stays and the vault is locked, wins again, and checks exactly one more payout. | `fe12f359` | the two tests themselves (removing the `spawned` exclusion in `rewards.ts` fails the first) |
| 7 | `TrialMarkers.update` reuses a pooled lookup map. The race order, facing and piece indices are precomputed. Scratch quaternions replace the per-frame ones. | `0e5d0711` | `TrialMarkers.test.ts` (behaviour, plus 30 frames with no quaternion clone and no `Map`; the old code clones 60) |

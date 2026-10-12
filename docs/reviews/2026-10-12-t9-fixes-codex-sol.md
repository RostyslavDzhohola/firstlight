# Review: lane/t9-fixes, Codex gpt-6.1-sol

Reviewed all 12 commits in `e87ce23..lane/t9-fixes`. No repository changes.

## Blocker

None found.

## Should-fix

1. **Honest repeated dodges trigger speed corrections.** `apps/server/src/world/movement.ts:140–146`.
   Driving the actual `PlayerController`, holding forward+sprint and dodging whenever its cooldown expires, produced **7/6/4/5 corrections at 20/30/40/60 fps** over 90 simulated seconds. The base validator produced zero under identical inputs. Frame rounding and deceleration after a dodge consume more distance than the idealized test accounts for, eventually exhausting the reserve.
   **Fix:** align client dodge motion and server distance accounting while preserving the spam restriction. Test actual controller positions at these frame rates over sustained play.

2. **Room disposal silently loses pending ground rewards.** `apps/server/src/world/npc/NpcSystem.ts:139`, `apps/server/src/world/npc/rewards.ts:146–147`.
   Confirmed through real server messages and SQLite: a kill's save fails, storage recovers, then the last player dies and leaves before the one-second retry. The room disposes with one pending payout. Its guaranteed camp chest never appears, although ground rewards are intended to survive recipient death or departure.
   **Fix:** retain the room until pending retries finish, or transfer rolled ground rewards to a queue that survives disposal. Continue forfeiting ineligible personal XP/coins. Add disposal coverage.

3. **The final portal tutorial step still completes outside the ring.** `apps/client/src/game/onboardingSteps.ts:100`.
   When the portal step is current, `atPortal=true` completes it despite `inPortal=false`. A player 1.5 m in front of the ring satisfies the server's reach check but has not entered. The new test explicitly accepts this weaker behavior.
   **Fix:** require `inPortal`; test that proximity alone never completes the step, including when its card is current.

## Nit

- **Ordinary names still hit the prefix filter.** `apps/server/src/db/names.ts:80`. `Serverless` and `Systemization` now return `"reserved"`. Add ordinary-word exceptions and regression cases if these names should remain available.

## Validation

- `pnpm typecheck`: passed. `pnpm --filter @firstlight/client build`: passed.
- Relevant tests: 19 files, 336 tests; initial run had one movement timeout. Rerunning that file alone passed all 37 tests.
- No additional defect found in synchronous payout transaction ordering, recipient-life checks, storage-gate recovery, or level-up HP persistence.
- Server travel still checks combat tags and the 4.5 m limit. Warm-up samples remain bounded and detached after use; WebGPU/WebGL2 shader behavior was not browser-verified.

**Merge: no**

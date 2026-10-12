# Review: lane/f12-core, Codex gpt-6.1-sol

Reviewed `dd4ed12..926e11d`, all 11 commits, read-only. Checkout remains clean. `pnpm typecheck` passed; 22 relevant test files passed, 271 tests. No timeouts occurred. Scratch probes used loopback only, with external fetch refused and TURN mocked.

## Blocker

**B6 remains open: quest rewards still leave mutations after rollback.** `apps/server/src/world/quests/QuestSystem.ts:298`
`grant()` uses raw `withTx`, bypassing `room.persist()`. With a throwing SQLite save, my probe left one axe and seven coins in memory while the database contained neither. Retrying persisted two axes and fourteen coins. Pickup, drop, and death rollback tests pass, but the reward path remains vulnerable.
**Fix:** wrap the entire quest/shop operation in rollback protection, including mission completion flags and XP mutations that occur before `grant()`. Add throwing-save tests for rewards, purchases, and overflow piles.

## Should-fix

1. **Valid uphill sprinting receives corrections.** `apps/server/src/world/movement.ts:120`
   Ascending movement pays the full 3D distance, while the real controller moves tangentially and snaps upward onto terrain. Driving the actual `PlayerController` against real terrain produced first speed refusals at 2.25 s on Arcadia, 4.75 s on Hollowmere, and 7.3 s on Meridian. Flat sprinting and running jumps passed.
   **Fix:** distinguish supported terrain ascent from airborne lift and apply matching traversal rules. The test at `apps/server/test/movement.test.ts:73` rescales steps to the validator's charged distance, masking this mismatch.

2. **Stacked knockbacks lose their accumulated vertical allowance.** `apps/server/src/world/movement.ts:164`
   Each shove replaces `airLiftV` with `jumpSpeed + latestStrength * 0.4`; the client adds impulses to its existing velocity. Six simultaneous strength-four shoves produced five height refusals, beginning at 0.45 s.
   **Fix:** carry the remaining server vertical velocity and add successive impulses. Test overlapping shoves during both jumps and falls.

3. **Destroying an idle player's support leaves them hovering.** `apps/server/src/world/BodyRoom.ts:1132`
   Gravity runs only when `a.airborne` is already true. A player standing on a prop has that flag cleared. Destroying their campwall and sending no further input left them 2.41 m above terrain after 2.5 s. The existing broken-crate test continuously sends inputs.
   **Fix:** recheck support independently of client input, start falling when support disappears, and resolve landing damage on the server.

4. **Unused-seat caps race with asynchronous reservation work.** `apps/server/src/app.ts:152`, `apps/server/src/world/matchmaking.ts:104`
   The count is checked before reservation work, then published afterward. With `_reserveSeat` delayed by 100 ms, concurrent HTTP requests obtained six seats for one account and twelve for one address. The per-body lock does not make the earlier check atomic.
   **Fix:** claim account/address capacity before awaiting reservation work; release it on failure or consumption. Test concurrent requests across bodies as well as within one body.

5. **Persistent death-save failures can repeatedly resurrect and disconnect the client.** `apps/server/src/world/BodyRoom.ts:936`, `apps/client/src/game/Game.ts:201`
   A failed death closes with 4002, but another join succeeds while persistence remains broken. A subsequent fatal event repeats the cycle. Three consecutive 4002 → live rejoin cycles reproduced with the save failure continuously enabled. Successful joins reset the client's reconnect-attempt budget.
   **Fix:** retain an account recovery state after persistence failure and refuse normal admission until storage recovers, with bounded retry/backoff. The test at `apps/server/test/rollback.test.ts:122` clears the failure before rejoining and misses this case.

6. **Footing needs the compound colliders already merged on main.** `apps/server/src/world/destruction.ts:123`
   This implementation examines only the primary `shape/hx/hz/h`. Main's client lane adds `parts` for statue bases, robe ledges, and pillar caps.
   **Fix:** reuse the shared compound-aware support calculation and make containment checks compound-aware too. Add agreement tests for bases, ledges, caps, and edges. (Merge integration finding; not executed on a merged checkout.)

## Nit

- **The message-cap test does not exercise respawn writes.** `apps/server/test/messages.test.ts:49` — it sends respawn to a living actor and makes no respawn assertion. **Fix:** exercise a dead actor, count persistence/response effects, and include `skySync`.
- **Mounted movement needs explicit limits during integration.** `apps/server/src/world/movement.ts:100`, `apps/server/src/world/BodyRoom.ts:605` — with walking limits, 14 and 16 m/s packets first fail after 0.95 and 0.60 s. **Fix:** expose speed and budget cap through the limits argument, preserve the 5 m bank and 600 ms dismount grace, disable mounted dodges, keep the new height validation.

## Original blockers

- **B1: closed** for sustained climbing, hovering, and silent airborne flight. Support-loss hovering is reported above.
- **B2: closed** for protection renewal, reviewed cooldowns/effects, and account-keyed boss marks.
- **B3: closed** for combat-tagged safe-zone leave and ticket escape; expiry/refusal tests pass.
- **B4: closed** for takeover, merge, and linger removal hooks.
- **B5: closed** for stale travel seats, merged guest seats, and signed-out seats.
- **B6: open** for quest/shop rewards; pickup/drop/death rollback paths pass.

Client ping is 0.5/s and sky sync is once per 120 s, comfortably below the new caps. No bundled-client optional-field disconnect mismatch found. A stale CDN bundle encountering the same server version reloads once, then receives a version error; it does not repeatedly reload.

**Merge: no.**

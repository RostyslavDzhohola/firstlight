# Review: lane/f12-npc, Codex gpt-6.1-sol

Reviewed `0df813f..6424de5`. Checkout remained unchanged.

## Blocker

**B1. Outside-arena attackers prevent reset while bypassing Royal Judgement.** `apps/server/src/world/npc/boss.ts:339`
`count` now includes recent hitters outside the arena and also controls `emptySince`. A player in the allowed outer 10-metre band can hit every five seconds and prevent the documented reset indefinitely. Royal Judgement still requires a target in `inArena`, so it never starts. A 60-second probe retained boss damage with zero arena occupants, zero resets and zero Judgement telegraphs. This permits accumulating damage outside the mandatory co-op mechanic before entering for the finishing hit.
**Fix:** Use `fighters` for HP scaling and targeting, but actual arena occupancy for the 30-second reset timer. Add a regression with continuous outer-band hits and nobody inside.

## Should-fix

**S1. Crash recovery makes occupied groups respawn early.** `apps/server/src/world/npc/NpcSystem.ts:197`, `apps/server/src/world/npc/persist.ts:40`
Countdown progress does not mark persistence dirty. Restoration subtracts full wall time since the last snapshot, including time when proximity slowed the live countdown. Confirmed: after 300 seconds beside a cleared camp, the live room had 150 seconds remaining; recreation without dispose restored the camp immediately.
**Fix:** Checkpoint countdown progress at the existing bounded save rate, or persist enough timing information to distinguish occupied time from downtime. Test recreation without `dispose()`.

**S2. Broken props are lost on a crash.** `apps/server/src/world/destruction.ts:211`
Destruction saves only during dispose. A prop broken in an occupied room has no durable update until the room closes gracefully. A SQLite close/reopen probe restored an intact prop while its live rebuild timer was still running.
**Fix:** Mark break/rebuild changes dirty and flush them periodically, with a final dispose flush.

**S3. Active bosses reset immediately when their room is recreated.** `apps/server/src/world/npc/persist.ts:31`
Snapshots retain only dead bosses. An active boss's HP, cover and fight state disappear on room disposal. Confirmed: recreation one second later changed Tidewrath from 11,800/12,000 HP to full HP, bypassing `docs/content.md:466`'s 30-second vacancy rule. This remains a gap in the B2 fix, although immediate recreation resets existed previously.
**Fix:** Preserve active fight state and the vacancy timestamp. Restore it while the absence remains shorter than the reset interval; apply the normal reset once that interval expires.

**S4. Reachable melee targets trigger evade and full healing.** `apps/server/src/world/npc/brain.ts:257`
`outOfReach` tests whether the NPC can occupy the target's location, without checking whether its melee attack already reaches the target. A player 14.5 metres from the pad is outside the 12-metre safe ring but inside the wolf's steering margin. Confirmed: the wolf successfully bit that player, then evaded after 6.55 seconds. Players can repeatedly force healing during otherwise valid combat.
**Fix:** Exempt attacks that can actually reach the target, including melee, and clear the unreachable timer when contact succeeds. Add a regression at the safe-ring margin.

**S5. Migration 3 conflicts with the data lane.** `apps/server/src/db/schema.ts:150`
This branch assigns migration 3 to `copy_state`; `lane/f12-data` assigns it to pile columns. A read-only merge preview confirms a textual conflict. A database already advanced to version 3 by either variant would skip the other migration.
**Fix:** Reconcile both changes into uniquely ordered migrations before deployment, accounting for any already-applied version-3 variant. The existing version-2 upgrade on this branch passed a local probe.

## Nit

**N1. Prop-occlusion tests substitute different geometry.** `apps/server/test/npc-review.test.ts:239`
The replacement cylinder host verifies NPC integration with a raycast, but cannot detect failures involving production `DestructionSystem` geometry or its composition with arena cover.
**Fix:** Add one real-system regression for NPC sight and bolts against an intact production prop, then break it and verify the path opens.

Typecheck passed. All 10 relevant test files passed, **178 tests**, including persistence, NPC, combat, destruction, type-stripping and benchmark tests. No timeout reruns were needed.

Graceful shutdown disposes rooms before closing the database. A real-server probe also verified copy 1 restoration under a two-copy limit and isolation from `lt:arcadia:0`.

**Merge: no**

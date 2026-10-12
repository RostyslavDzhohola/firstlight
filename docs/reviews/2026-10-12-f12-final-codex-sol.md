# F12 final review (Codex gpt-6.1-sol, high), commit 668ec82

The previously reported blocker scenarios are closed. Two additional payout failures prevent sign-off: mission XP can be permanently lost, and onboarding completion can pay twice after a post-commit error.

## Checks run

- Checkout verified at `668ec8284daa204a61a91c77e3ec7723d32ee94d`, detached and clean before and after review. No repository files changed.
- `pnpm typecheck`: passed, exit 0, for shared/server/client.
- `pnpm vitest run --no-cache --configLoader runner --maxWorkers 3`: passed, exit 0. **102 files / 902 tests**, 128.09 seconds. One full run; no timeout reruns needed. Cache/config flags preserve the read-only checkout; three workers limit shared-machine load.
- Re-ran adapted original core rollback/seat/support-loss, outside-arena boss, fuel-drum interception and repeated-block probes. Added SQLite migration, mission payout, onboarding post-commit, assisted-medal, prop traversal and checkpoint-retry probes. Source, databases and logs are exclusively under `(scratch) `.
- Node processes used an offline preload refusing non-loopback fetches and clearing inherited service credentials. TURN was mocked. No browser, computer use, live-site requests or external services.
- Reviewed the merged movement/horse/prop/knockback paths; combat/bubble/arena-cover composition; quest and onboarding persistence; copy-state restoration; auth/social/admin/voice boundaries; client inventory, arrivals and reconnects; sky/render/worker integration; and local asset/licence records.
- Migration fixtures populated versions 1, 2, 3 and 4, then upgraded/reopened at version 5. Character XP, coins and JSON, pile contents/kind/expiry, existing copy restrictions and idempotence passed. The v4 fixture gained `voice_mute` without losing existing rows. This checks the committed schema, not the live production database.
- Protocol version 2 admission tests passed. Inspected the once-per-server-version reload guard. Close-code/arrival/boot tests passed for 4100–4105. Normal client input is 20/s, ping 0.5/s and sky sync once per 120 seconds; these fit the 60/s room cap and per-type caps. Mounted limits, dismount grace, terrain ascent, stacked knockback and compound footing regressions passed.

Evidence: [typecheck log]((scratch) typecheck.log), [test log]((scratch) vitest.log), [migration probe]((scratch) migration-probe.log).

## Prior blockers

Every test referenced below ran in the passing full suite. “Closed” refers to the earlier reported scenario; new B1/B2 below cover additional payout boundaries.

| Prior review / blocker | Status | How verified at 668ec82 |
|---|---|---|
| Codex B1: unlimited flight | Closed | `movement.test.ts`: centimetre-per-packet climbing is corrected; sustained hovering and silent airborne bodies fall; ordinary running jumps remain accepted. Reviewed ballistic envelope and charged displacement tolerance. |
| Codex B2: takeover resets effects/cooldowns; boss marks bypassed | Closed | `lifecycle.test.ts`: protection expiry, burn/heals, combat state and cooldowns survive replacement; repeated takeovers do not renew protection. A marked Royal Judgement participant replacing its session and running still takes the account-keyed obligation. |
| Codex B3: combat-tagged disconnect/ticket escape | Closed | `lifecycle.test.ts`: combat-tagged safe-zone leave and ticket holders linger; combat travel is denied; tickets expire. Reviewed calm-and-safe/actual-portal handoff checks. |
| Codex B4: retirement skips leave hooks/TURN revocation | Closed | `lifecycle.test.ts`: takeover, merge and linger cleanup invoke hooks once. Reviewed idempotent `detach`/`removeBody`; `voice.test.ts` verifies credential revocation on leave. Onboarding takeover cleanup also passed. |
| Codex B5: stale reservations bypass identity/travel | Closed | `seats.test.ts`: old-body seats, merged guest seats and signed-out seats are refused. Admission revalidates identity and current travel eligibility before takeover; seats are single-use. |
| Codex B6: rollback retains inventory mutations/dupes | Closed | SQLite `rollback.test.ts` covers pickup/drop/death, purchase, mission reward and overflow failures. Adapted original `core-probes.mts`: failed grant left zero axes/coins in memory and SQLite; successful retry persisted exactly one axe and seven coins. |
| Codex B7: unlimited permanent egg NPCs | Closed | `egg-penalties.test.ts`: account lockout, account/room caps, TTL removal and rewardless penalty kills. Reviewed stage spawns using the same bounded spawn path. |
| Sonnet B1: uncapped permanent egg NPCs / XP farm | Closed | Same cap/TTL tests plus penalty kills awarding zero XP, coins and drops. `rewardKill` returns before payout or hunt credit for penalty/stage NPCs. |
| Sonnet B2: missing inventory UI | Closed | `InventoryClient` registers I and the panel/model expose all 20 slots. `inventoryModel.test.ts` covers equip, move/swap, drop and backpack use; `inventory.test.ts` verifies real server operations, loot routing, backpack Bubble and Patchkit effects. UI wiring inspected without a browser. |
| Opus B1: repeated block exhausts victim TURN budget | Closed | Adapted attack sent 12 blocks: one initial mint, zero revokes, one available ICE response. `voice.test.ts` additionally covers alternating unblock/block, voice-panel blocks, recently signalled pairs, one rotation per ten minutes, separate rotation budget and failed-mint preservation. |
| Opus B2: room recreation resets boss/group respawns | Closed | `copy-state.test.ts`: killed boss stays dead after copy recreation and SQLite restart; cleared camps/partial packs remain depleted; expired timers respawn normally. Also passed slowed-countdown crash, broken-prop checkpoint and active-fight restoration regressions. Reviewed load-test/public copy-key isolation and shutdown ordering. |
| Core lane B6: quest/shop grant rollback duplication | Closed | Adapted original throwing-save grant probe no longer duplicates axes/coins. Mission, purchase and overflow rollback regressions passed. The separate XP-after-commit loss is new B1 below. |
| Data lane B1: piercing/player/shell collision ordering | Closed | `support-unit.test.ts`: piercing bolt hits the outside victim, processes the remaining segment and stops at the shell; inside victim stays protected. NPC bolt hits a player before the shell. Reviewed nearest-collision loop. |
| Data lane B2: splash bypass through fuel drums | Closed | Adapted original drum probe: player stayed at 100 HP, drum remained intact, shell fell from 150 to 105.84 HP. Production-drum and chained-blast interception regressions passed. |
| Data lane B3: recreated copy loses staged/assisted status | Closed | `stage-admin.test.ts`: staged restriction survives room recreation and SQLite restart; permanent medal writes and deferred staged progress are suppressed. Reviewed absolute staged/assisted expiries under the persisted copy key. |
| NPC lane B1: outer-band attackers prevent reset/bypass Judgement | Closed | Adapted 60-second outer-band attack retained full 28,000 HP with zero arena occupants; all attacks were refused. `npc-review.test.ts` also verifies continued outer-band hits cannot delay the 30-second reset after the arena empties. |

The social, sky, client and UI lane reports contained no Blocker entries.

## Blocker

### B1. Mission completion commits before its XP, permanently losing the payout on interruption

`apps/server/src/world/quests/QuestSystem.ts:643,653`; `apps/server/src/world/BodyRoom.ts:951`.

`completeMission()` commits items, coins and `done=true` through `grant()`, then calls `grantXp()` outside that transaction. If XP does not cross a level, `grantXp()` performs no immediate save. A restart before autosave restores a completed mission with its old XP, and completion retries return immediately because `m.done` is already true. Crossing a level adds a second save that can fail after completion committed.

SQLite probe: completing A1 at level 5 produced **930 live XP / 850 stored XP**, with the stored mission done and its 30 coins paid. Rehydrating that row and retrying left XP at 850. A second probe failed only the post-commit level-up save: SQLite retained `done=true` and **0 XP instead of 80**. Existing rollback tests fail the first save and miss both cases.

**Fix:** persist XP and level with mission completion, coins, inventory and overflow in one transaction. Apply live HP/level changes and emit notifications after commit through a path that does not save or reapply XP. Add no-level-up restart and second-write-failure regressions.

Evidence: [probe source]((scratch) reward-probe.mts), [results]((scratch) reward-probe.log).

### B2. Onboarding can pay completion twice after its transaction already committed

`apps/server/src/world/onboarding.ts:132,166,182,189`.

The payout transaction commits XP, completion and Spark. It then restores the old live XP and calls `grantXp()`, which saves again on level-up. If that second save throws, execution never reaches `ended()`, leaving an all-down trainee active. The next valid training hit retries completion. `payout()` increments the completion stat and grants 20 XP without checking that completion was already paid.

Injected failure only on the second save of the final dummy attack. SQLite already held **50 XP / completion=1**, while the trainee remained active. After waiting for the normal attack cooldown and training again, SQLite held **70 XP / completion=2**. The retry is a normal training attack; the failure injection establishes the storage boundary.

**Fix:** make completion payment conditional on a first durable completion transition. Apply committed live state and retire the trainee before fallible notifications; avoid a second persistence operation in the after-commit XP notification path. Test failure after successful payout commit and repeated training afterward.

Evidence: [probe source]((scratch) onboarding-postcommit-probe.mts), [results]((scratch) onboarding-postcommit-probe.log).

## Should-fix

### S1. Assisted boss XP awards permanent level medals before the life becomes unofficial

`apps/server/src/world/npc/boss.ts:581,587`; `apps/server/src/world/quests/QuestSystem.ts:811,866`.

Boss loot calls `grantXp()` before emitting `bossKill`. Its synchronous `levelUp` event awards Ten Down/Firstlight while `life.unofficial` is still false. The boss-kill listener marks the life unofficial afterward. Probe: an assisted Tidewrath payout took a level-9 character to 11 and permanently awarded `ten_down`, although `official({boss:true})` was false.

**Fix:** mark affected lives unofficial before granting assisted boss XP, and propagate that reward context into medal checks. Test a real assisted boss kill crossing levels 10 and 20. [Evidence]((scratch) assisted-probe.log).

### S2. Server prop collision checks endpoints, allowing traversal through a thin fence

`apps/server/src/world/movement.ts:115,136`.

The client now substeps collision, but the server checks only the destination footing. A modified client can submit a budget-valid step whose endpoints are outside the prop. A production Arcadia fence probe accepted a **1.397 m** step through its solid middle; the shared collider correctly blocked the midpoint.

**Fix:** sweep/substep the authoritative movement segment using the shared collider, preserving supported steps and escape from props rebuilt around players. [Evidence]((scratch) prop-traverse-probe.log).

### S3. Failed copy checkpoints clear dirty state and are not retried after storage recovers

`apps/server/src/world/destruction.ts:93`; `apps/server/src/world/npc/NpcSystem.ts:187`; `apps/server/src/world/copyState.ts:68`.

Both checkpoint methods clear `copyDirty` before a save whose errors are swallowed. One transient failure leaves unchanged state unsaved until another change or disposal. SQLite probe: a failed crate checkpoint was attempted once; ten seconds after storage recovery, the live crate was broken but recreation restored it intact. NPC checkpoints use the same pattern.

**Fix:** return checkpoint success and clear dirty state only on success; retry failures with bounded backoff. Keep current restrictions in memory while durable writes are retried. [Evidence]((scratch) copy-retry-probe.log).

## Nit

None additional.

F12 sign-off: no — 2 blockers

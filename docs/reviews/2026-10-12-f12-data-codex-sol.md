# Review: lane/f12-data, Codex gpt-6.1-sol

Reviewed `dd4ed12..fbdeae3`, all 14 commits. Repository unchanged. (Round 1 retried once after a "model at capacity" failure.)

Validation: `pnpm typecheck` passed. All 22 selected test files passed: **179 passed, 1 TODO**, with no timeouts.

## Blocker

### B1. Projectile collision ordering lets piercing shots bypass bubbles
`apps/server/src/world/combat.ts:640`, `:657`, `:710`; `apps/server/src/world/npc/attacks.ts:516`.
A Hexquill hits someone immediately before the shell. Because an actor precedes the shell, the shell branch is skipped. After applying piercing damage, the projectile advances its entire segment, crossing into the bubble without charging its HP. The next tick damages someone inside. Confirmed probe: both victims fell from 100 to 74 HP; shell stayed at 150 HP. NPC bolts have the opposite ordering error: any shell crossing anywhere in the segment wins before player collisions. A player before the shell incorrectly escapes damage.
**Fix:** Resolve the nearest collision, then process the remaining segment after piercing. NPC bolts must likewise compare player and shell collision distances.

### B2. Splash reaches through bubbles via fuel drums
`apps/server/src/world/combat.ts:600`; `apps/server/src/world/destruction.ts:109`, `:158`, `:179`.
A rocket explodes outside a bubble surrounding a fuel drum. The player splash is intercepted, but `props.splash()` damages the drum through the shell. Its explosion starts inside the bubble and damages the protected player. Confirmed with a normal 3 m bubble: player HP became **77**, the drum broke, and the shell still had approximately **106 HP**.
**Fix:** Apply shell interception to splash against props and chained drum explosions. Absorb intercepted damage consistently.

### B3. Recreating a copy clears staged and assisted status
`apps/server/src/world/quests/QuestSystem.ts:124`, `:126`, `:220`, `:229`.
Staging and assistance timestamps belong to the `QuestSystem` instance. Emptying a room or restarting the server recreates them as zero, allowing permanent records before the promised exclusion window expires. Confirmed through SDK clients: Portus copy **0** was unofficial after staging; leaving and rejoining recreated copy **0** as official immediately.
**Fix:** Retain absolute expiry times keyed by body/copy outside the room instance and persist them across restarts. Rehydrate before accepting record-producing actions.

## Should-fix

### S1. Penalty kills remain a repeatable coin faucet
`apps/server/src/world/npc/rewards.ts:118`, `:123`, `:131`.
Only XP decays. Wrong E2 answers produce three level-3 Hopbits every 15 seconds, paying **12 coins per wave**. E5 produces two level-9 Bonewalkers paying **18 coins per wave**. Killing each wave frees the cap immediately; coins and tonic drops never decay. Confirmed over 12 kills per egg. Theoretical rates **48/72 coins per minute**, before drops.
**Fix:** Make penalty NPCs rewardless, or impose an account-level reward budget covering coins, XP and drops.

### S2. Account cooldowns and puzzle lockouts are actually room-local
`apps/server/src/world/support.ts:157`, `:236`; `apps/server/src/world/quests/eggs.ts:48`, `:50`.
A bubble cooldown survives takeover in an existing room, but switching copies/bodies or recreating the room starts another cooldown map. E2/E5 and E7 similarly receive independent lockouts in different copies.
**Fix:** Store these timers in shared account-level state, keyed additionally by puzzle where appropriate. Preserve active timers during room disposal.

### S3. Splash protection depends on victim iteration order
`apps/server/src/world/combat.ts:586`.
With a nearly depleted shell, the first protected victim causes `absorb()` to pop it. Later victims encounter no shell and take the same explosion. Confirmed: two colocated players received **100/81 HP**; reversing their iteration order reversed who was protected.
**Fix:** Determine interception for all victims before mutating shells, then apply shell damage once. Define overflow damage explicitly.

### S4. Staged copies still award other permanent medals
`apps/server/src/world/quests/QuestSystem.ts:418`, `:673`, `:773`.
`official()` guards selected boss, egg and Long Shot paths, but `award()` has no staging guard. XP from a staged boss can still award Ten Down or Firstlight. Confirmed: a staged room with `official() === false` awarded `ten_down`.
**Fix:** Centralize the staging restriction at the permanent medal-write boundary. Also prevent staged progress counters from producing deferred medals after staging ends.

### S5. The Golden Hopbit does not return when its timer expires
`apps/server/src/world/npc/NpcSystem.ts:202`, `:219`, `:385`.
Retiring the Golden Hopbit marks its group member dead. Expiring `goldenBack` never clears that member or respawns it while the ordinary pack remains alive. The existing test clears the pack again after advancing the timer, masking this. Confirmed: after 15 minutes, the pack remained active with five ordinary members and no Golden Hopbit.
**Fix:** Track and respawn the golden member independently when its timer expires. Preserve its deadline across copy recreation and restart if the return timer must survive those events.

### S6. The Receiver's Sweep Laser ignores bubbles
`apps/server/src/world/npc/boss.ts:638`; `apps/server/src/world/npc/NpcSystem.ts:479`.
Sweep Laser calls `hitPlayer()` without `src`, bypassing interception. Confirmed: a bubbled L20 player fell from **290 to 140 HP** while the shell remained at **150 HP**.
**Fix:** Supply the authoritative beam source and route the beam through shell interception.

### S7. Some intercepted attacks never damage the shell
`apps/server/src/world/combat.ts:434`; `apps/server/src/world/destruction.ts:179`.
Stormcoil checks subsequent jumps using `clearLine(..., 0)`, so a shell blocking a jump takes no damage. Fuel-drum blasts skip shielded victims without calling `absorb()`.
**Fix:** Separate visibility queries from actual attack interception. Charge the selected intercepted jump and charge each drum blast once per shell.

### S8. Late joiners receive invisible bubble colliders
`apps/server/src/world/support.ts:243`, `:257`; `apps/client/src/game/CombatClient.ts:73`.
Bubble creation is an ephemeral broadcast. There is no join/reconnect snapshot of active bubbles. A joining or replacement client can have shots blocked by a shell it never renders.
**Fix:** Add support-state synchronization after client handlers attach, including remaining lifetime and HP. Reconcile it on reconnect.

### S9. Patchkit heals through solid cover
`apps/server/src/world/support.ts:188`, `:196`, `:210`; `apps/client/src/game/CombatClient.ts:340`.
Client selection and server validation check proximity without cover visibility. A supplied target ID heals someone behind a wall within reach.
**Fix:** Check terrain and prop line of sight at channel start and completion. Healing strangers, including PvP opponents, is allowed by content.md.

## Nit

### N1. Partial E7 failure counters never expire
`apps/server/src/world/quests/eggs.ts:83`. Accounts with one to four failures have `until: 0`; pruning never removes them.
**Fix:** Track last activity and prune idle counters while retaining active lockouts.

### N2. The contract test proves emitter text exists, not that each path works
`apps/server/test/contracts.test.ts:86`. The hidden-egg check accepts one generic NPC egg emitter for both E3 and E9; the E3 quest test injects `secretStep` directly.
**Fix:** Add behavioural coverage for each distinct producer path, especially the Golden Hopbit follow/return cycle.

Migration 3 passed a scratch upgrade from a populated version-2 database: legacy rows retained their data, `kind` became non-null `death`, and `expires_at` remained nullable. Pile eviction matches the requested order and protects the new pile. At an all-death cap, it can still evict a death pile whose owner is returning; there is no return grace period.

**Merge: no**

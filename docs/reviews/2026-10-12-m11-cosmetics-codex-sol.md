# Review: lane/m11-cosmetics, Codex gpt-6.1-sol

Reviewed main..lane/m11-cosmetics at bfffbe3, base 3cea448.

## Blocker

- **B1. Egg claims can permanently lose their records.** `apps/server/src/world/quests/QuestSystem.ts:799` and `:811`. The new eggs reuse an existing helper that commits the item and per-life claim before writing the medal and Hall entry. A real-message SQLite probe injected a medal-write failure: the claimant kept the item, but retrying was refused as already claimed. After reopening the database, a later finisher received the first-finder plaque. A crash between these commits has the same gap. Fix: commit the item, life flag, eligible medal and first-finder reservation in one transaction; publish cache changes and messages after commit. Add failure/restart tests for all three new eggs. This defect predates the branch in the shared claim helper, but affects all new eggs.

## Should-fix

- **S1. The advertised per-life pity guarantee resets with a room.** `apps/server/src/world/npc/rewards.ts:76`, `docs/content.md:783`. New counters live only in `NpcSystem.cosmeticPity`; copy snapshots omit them. The same account and life accumulated 539 unsuccessful rolls, recreated the same copy, then its next roll restarted at 1 instead of guaranteeing Petalwake Mask. Changing copies or restarting also loses progress. Fix: retain counters by account, life and cosmetic across room/copy lifecycles, and test restoration. The old drops share this limitation; the new catalogue repeats the unsupported guarantee.

## Nit

- **N1. Expiry tests depend on sleeps.** `apps/server/test/m11-eggs.test.ts:103`, `:110`, `:124`. Fixed waits with narrow margins can become flaky on the shared machine and violate AGENTS.md's condition-based waiting rule. Fix: use `until` on account timer expiry, as the dial test does. Keep deliberate message pacing separate from waiting for state transitions.

Validation: `pnpm typecheck` and `pnpm --filter @firstlight/client build` passed. All 253 tests across 13 relevant files passed, including M11 eggs, catalogue, NPC rewards, cosmetics, quests, penalties, persistence, copy-state, message guards and erasable syntax. Scratch probes confirmed simultaneous finishers produce one SQLite Hall entry, completed Hall records survive reopen, M3 flag gating works, and takeover cannot duplicate a life claim.

Original cosmetic/medal prefixes are preserved; NPC_DEFS is unchanged. No new sellable egg reward, XP/coin faucet, bundled keypad solution, or obvious IP-name conflict found. The new interactions use the existing 5/s quest budget; lockouts are account-keyed and process-wide. Procedural geometry and retained-sample tests passed; WebGPU/WebGL2 runtime compilation was not exercised because browser use was excluded. Tracked checkout remains clean; probes are under (scratch) .

Merge: no

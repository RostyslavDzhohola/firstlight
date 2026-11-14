# Review: build tree lane (`night/progress` at `8b656050`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** Migration numbering blocks integration; movement, persistence, balance
coverage and the starter scope need correction.

## Findings

1. **Blocker, `apps/server/src/db/schema.ts:277`: migration 12 is taken on integration.** The runner uses
   array position. On an integration-shaped database at `user_version=12` this lane's runner skips
   creating `character_tree`, and reads fail with `no such table` (confirmed with an in-memory probe).
   Keep integration's 11 and 12, append this SQL as entry 13, update the labels in the storage tests and
   D-progress-2, and test upgrading an integration v12 database.
2. **Should-fix, `apps/server/src/world/movement.ts:220`: one dodge consumes both Second Roll charges.**
   The client sends `DODGE` through its 300 ms roll; the server counts successive packets as separate
   roll starts while a charge remains (packets 50 ms apart spent two). Count a charge per distinct,
   server-validated roll start, at least a roll's length apart; add a packet-sequence test.
3. **Should-fix, `apps/server/src/world/tree.ts:49`: a failed save leaves choices and the coin deduction
   applied in memory.** Confirmed with a throwing save: the respec removed the tree and took the coins.
   Use the existing transaction and rollback pattern, restore HP too, answer `denied`, publish the tree
   event only after the save.
4. **Should-fix, `tools/balance/model.ts:1082`: the balance checks leave out defensive tree effects**
   (Iron Guard, Last Breath, tonic nodes). T2 Sunbrand's block goes from 75% to 90%. A mutation granting
   Iron Guard 90 points still passed every check. Model them in built-versus-plain fights and band them.
5. **Should-fix, `apps/server/src/world/BodyRoom.ts:860`: Quick Hands does not affect manual reloads**
   (1,400 ms instead of 980 ms). Share the reload-duration calculation.
6. **Should-fix, `docs/DECISIONS.md` D-progress-4: the plain starter is missing.** Append a neutral
   starter without changing existing ids, list it first, default new characters to it, include it in the
   balance checks.

## Checked and sound

Server-owned node choice, prerequisites, point accounting, exact respec price, server safe-zone rule;
handlers synchronous, validated, five messages a second. Effect consumers for damage, heavies, ranged
draw and falloff, spells, heat, tonics, fall damage and Last Breath read the saved tree; movement limits
derive from it; mounts and loot take no client multipliers. Body HP keeps regeneration's combat delay.
Rebirth clears the tree; takeover carries cooldowns; account linking moves the winner's tree; old saves
get an empty tree. Tests: server tree 7/7, shared tree 5/5, client tree model 3/3, agent integration 9/9;
balance 825/825.

## Not checked

Pad and touch on devices, WebGL2, the films, performance, reconnect, portal and account-merge races.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | Merged `night/integration`; the tree's `character_tree` SQL is migration 13 after the funnel's 11 and 12; a test upgrades a database already at `user_version` 12 with the funnel's tables and rows (D-progress-2 updated). | `b17b9158` |
| 2 | Roll starts are at least `ROLL_GAP_MS` (400 ms, longer than a 300 ms roll) apart on server and client (shared `rollReady`), so a roll's own `DODGE` packets spend one charge. Tests drive the real packet sequence through `validateMove` (six packets 50 ms apart, then a second roll) with and without the node; without it the second roll's steps are refused. The client's prediction holds the same gap. | `5b31ea17` |
| 3 | Spend and respec run inside the room's `persist` transaction; a throwing save puts the tree and coins back, restores HP, answers `denied` "try again" (the panel says so) and publishes no event. Tested with a throwing save for both. | `a429f438` |
| 4 | The model holds every build against plain in PvP (each attacker family) and PvE (the level's creatures) on expected effective HP with max HP, roll charges, the guard at each blocking weapon's tier, Last Breath, Tonic Craft's heal and cleanse; a new check per guard weapon tier. Modelled honestly the full Body branch with a guard reached 1.68 at level 20, so node numbers changed (Hardy ×1.06, Tonic Craft ×1.2, Iron Guard +5, Keen Edge / Steady Hands / Attuned ×1.08; content §1.6, D-progress-5). Mutation tests: Iron Guard +90, Tonic Craft ×4, Hardy ×1.5, six roll charges each fail a check. | `bab1db2d` |
| 5 | `reloadMs` (content/tree.ts) is the one reload formula: the server's empty-magazine and manual reloads, the agent kit and the balance model. Tested on both server paths with and without Quick Hands. | `4397c6ac` |
| 6 | The Traveller, a sixth starter appended at index 5: base numbers, a Sunbrand I, Brother Ash's body; listed first and picked when nothing is stored; in the balance model (exempt from "leads a role", checked to be base). D-progress-4 revised. | `659f4871` |

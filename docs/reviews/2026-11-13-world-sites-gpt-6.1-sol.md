# Review: world sites lane (`night/world` at `a1d4840f`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** No confirmed blockers; tower traversal, persisted loot and balance
coverage need fixes before a deploy.

## Findings

1. **Should-fix, `tools/blender/sites/build_sites.py:263`: tower stairs block ordinary walking.**
   Confirmed with the real `PlayerController`: starting on the first tread and walking at the second for
   3 s leaves the player blocked at the riser on Bellwether Watch and Relay Mast Four (the resolver pushes
   sideways before the step-up region). The stair test (`wildSites.test.ts:135`) checks adjacency and
   height only. Fix step-up for these treads; replace the graph-only test with a controller walk to the
   lookout.
2. **Should-fix, `packages/shared/src/content/wildSitePrefabs.ts:221`: new solids can enclose existing
   loot piles.** Piles are restored unchanged (`BodyRoom.ts:332`); one under the wreck at prefab
   `(9.75, 0)` ends up inside the hull, nearest clear ground about 4.2 m away, beyond the 3.5 m pickup
   range (geometric, not reproduced on a persisted server). Move enclosed piles to clear ground on load,
   persist the move, test an old pile under the new hull.
3. **Should-fix, `packages/shared/src/content/wildSites.ts:41`: the balance gate does not include the new
   rewards** (4,505 discovery XP, nine guardian packs, chests). `tools/balance/model.ts:754` models only
   the old areas. Extend the route model to the sites and check progression against the bands.

## Checked and sound

Shared wild-site tests 19 passed, server site tests 2, the frozen breakable-seed test 1. All 56 site
spawn members passed a clearance probe. Placement and colliders are shared deterministic code with no
side-specific state. Discovery flags and XP are saved together; reconnects and second tabs inherit the
authoritative character; rebirth resets both; agent seats use the same path. Chests reuse the camp
ownership and payout paths. The GLBs have identity transforms and one primitive per mesh; a failed load
draws the collider fallback.

## Not checked

Browser rendering on either backend, frame time and shadow cost, every movement, portal and Skipstep
case, exhaustive creature navigation, reconnect and save-failure tests specific to discovery.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |

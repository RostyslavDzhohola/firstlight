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
| 1 | The cause was the shared step rule, not the treads: the side push started at an overlap, but a top only counted as floor with the centre within half the body radius of its edge, so no riser of any height could be walked. A top within `step` (0.35 m) above the feet is now a floor once the body overlaps it, in the push and in the server's support check alike (D-fix-world-1). The prefabs also blocked the stair heads (Bellwether's rail gap was 0.66 m between the rail end and the corner post; Relay's stair ended on the east face behind a full rail). Rebuilt in Blender, so each stair ends in a walkway one riser below the deck, past a 1.3 m (Bellwether) or 1.7 m (Relay) rail gap. The mast's legs block on the deck, and Relay's lookout moves off the mast core. `apps/server/test/wild-site-climb.test.ts`: the real `PlayerController` walks both towers from the ground to the lookout at 20 and 60 fps, every 20 Hz packet through `validateMove`, no refusal (fails on the old rule at the first riser). The graph-only test is gone. | `c831f920` |
| 2 | On load a room moves a pile lying inside a structure or natural solid to the nearest clear ground, found the way a player is placed (`clearOfStructures`), saves the move (`PileStore.move`, memory and SQLite) and tells the body's other copy. A new pile dropped under a lookout or a wall top goes the same way, not into the core. Test: an old pile under the wreck's hull at prefab (9.75, 0) moves out, is saved, and is picked up. Also checked: saved character positions already go through `placeBody` (test: a save inside the hull joins clear). Horses are never saved, the death marker is the death pile, and the boss state lies in arenas the sites keep 30 m from. | `7f4fd27c`, `a0a47e8e` |
| 3 | `tools/balance` does each site once at its band's lower level: discovery, one clear of the guardian and pack, the chest's coins, 90 s for the trip. It also prints a site table. Two bands broke (level 5 at 6.4 min against 7–13; level 11 at 2.3 times its neighbours against ≤ 2), so the site numbers moved, not the bands: discovery is 10 % of a level (was 30 %), Bellwether fields 2 Hopbits (was 4), and Emberfall fields 1 Bomblet and 1 Hopbit (was 2 and 3). Result: 653/653 in band, level 5 at 7.8 min, the cap at 78 min (86 without the sites). `docs/content.md` §3.7, D-fix-world-2. | `0428ed25` |

# Review: sky and moon lane (`night/sky` at `537cd494`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** The sky and moon largely work, but mounted jumps trigger corrections,
mission L1 cannot be taken in the browser, and several consumers still leave Lumen out. No security
blocker.

## Findings

1. **Should-fix, `apps/client/src/game/PlayerController.ts:467`, `apps/server/src/world/movement.ts:129`:
   mounted jumps leave the validated envelope.** Tangential movement on the small sphere adds radial lift
   while the server assumes a ballistic radial path. Confirmed with the real controller against
   `validateMove`: a 16 m/s mounted jump on Lumen fails with `height` at 1.20 s (a flat 240 m sphere
   reproduces it; the on-foot sprint-jump passes). Integrate radial displacement apart from tangential;
   add a mounted low-gravity regression test.
2. **Should-fix, `packages/shared/src/content/missions.ts:221`, `apps/client/src/ui/panels.ts:138`: Lark
   never offers L1.** L1 has `giver: "guide_arcadia"`, but `GuidePanel` uses `missionsOn()`, which leaves
   out every mission with an explicit giver. Confirmed by execution. Use `missionsFrom(g.id)`; test it.
3. **Should-fix, `apps/client/src/game/QuestClient.ts:76`: Surveyor Odile cannot be opened.** The guide
   panel is created only for `PLANET_IDS`, which excludes Lumen. Gate on `GUIDES[body]`; test it.
4. **Should-fix: planet-only UI lists give missing or wrong moon information.** `panels.ts:274`: the
   Sites journal counts the Quietfall Wreck in its total but never draws its row. `homeModel.ts:134`: the
   pad counter's total leaves out Lumen's 12 pads while the count includes them (it can pass 44).
   `mapMarkers.ts:82`: Arcadia's moon portal and Lumen's return portal both say "Portal to Portus".
5. **Should-fix, `packages/agent-kit/src/walker.ts:203`: agents keep normal gravity on Lumen** (hard-coded
   `WALK.gravity = 18`). Use `bodyGravity(w.body)`.

## Checked and sound

Gravity comes from the server room's body; movement packets cannot choose it; reconnect, travel,
mounting, Skipstep, admin teleport and the sandbox do not carry another body's gravity. Creature kinds
and L1 are appended. Rooms, travel validation, agent body and travel enums, saved positions,
leaderboards and `/stats` take Lumen. Orbits stay finite and continuous across a day boundary and near
`Number.MAX_SAFE_INTEGER`; the night key light eases between bodies; orbit updates reuse scratch
storage; sky bodies are two instanced draws. Fall damage: small hops harmless, Lumen safe through 32 m,
lethal at 82 m. Tests: Lumen 5, orbits 8, vegetation 5, avatars 17, shaders 35, environment 31, shared
quests 17; balance 668/668. The lane's three client timeouts did not reproduce alone and are not on
paths it changed.

## Not checked

Browser and device behaviour, rendering on either backend, frame times, the footage.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | The client was the wrong side: it moved in a straight 3D line through the air, so fast ground motion on a small sphere lifted it (1.07 m/s² at a 16 m/s gallop on Lumen). `PlayerController.advance` now moves the ground part along the great circle (velocity and roll heading turned with it) and the radial part straight; a jump is as high at any speed and the server's envelope is unchanged on every body (D-fix-moon-1). New `apps/server/test/air-envelope-bodies.test.ts`: the real controller against `validateMove`, sprint-jumps and galloping jumps on all five bodies, a roll into a jump at 60 and 20 fps and a Skipstep mid-jump on Lumen (3 of 13 failed before, 13 pass). In the browser: 3 corrections in 4 galloping jumps before, 0 after. | `de580b53` |
| 2 | `GuidePanel` lists `missionsFrom(guide)`, so Lark offers L1 after her four; test drives the real panel (happy-dom) and Accept sends `accept L1`. The live harness's `talk` macro took at most four missions; it takes every Accept now. Agent kit `BodyWorld.missions()` had the same `missionsOn` gap. | `1830b961`, `0f555249`, `27b85d3f` |
| 3 | `QuestClient` builds a guide panel for every body with a guide (`guideBody`); Surveyor Odile's panel also shows the missions on her body that others give (L1, read-only, with progress and "Lark on Arcadia gives this one"). Walking the path then showed L1's pointer had nowhere to go once no Glimmerhop was in view: hunts may name a wild site (`hunt.site`, D-fix-moon-2), L1 names the Quietfall Wreck, and the pointer, map, minimap and the agent kit's `missionSpot` lead there. | `1830b961`, `0f555249`, `2ad292eb`, `27b85d3f` |
| 4 | Journal Sites draws a row for every body with sites (the wreck included); the home pad counter's total counts every body's pads (56); map portals are labelled by where they go ("Portal to Lumen", "Portal to Arcadia"). Sweep also fixed: the loading screen on the way up named Arcadia (BodyKey had no lumen), Lumen's HUD and arrival-card accent fell back to the default blue. | `2934c55b`, `c2732607`, `27b85d3f` |
| 5 | The agent kit's walker falls with `bodyGravity(world.body)` (9.45 m in 1 s on Lumen before, 2.25 m after). | `2934c55b` |

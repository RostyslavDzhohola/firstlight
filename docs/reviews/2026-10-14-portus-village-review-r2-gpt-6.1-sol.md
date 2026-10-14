# Portus village review, round 2

Reviewed by GPT-6.1 Sol on 2026-10-14. Report only. No source changes, commits, merges, deployments or full-suite run.

Worktree `fl-wt-village`, branch `lane/portus-village`, reviewed tip `f912725640a2edc840fae028ee0100875d196a4c`. Scope: `git diff a5c9fc2..f912725`. Read AGENTS.md, the original `/tmp/fl-village-integration-brief.md`, the round-1 GPT-6.1 report, the builder's Opus report and response, and the affected runtime paths.

**Findings: 0 blockers, 1 should-fix, 0 new nits. All seven round-1 findings are closed.**

**Merge verdict: hold for S4.** The saved-position correction loop is fixed. The new physical Hall board stand has no matching shared collider, so players can occupy its stone base and pass through the board. Fix that before merging. Runtime visual appearance, measured frame rate and actual post-warm-up shader-build counts are not signed off by this review.

## Should-fix

### S4. The Hall board's new stone stand and backing are pass-through

`apps/client/src/world/QuestWorld.ts:241`, `apps/client/src/world/QuestWorld.ts:244`, `apps/client/src/world/QuestWorld.ts:247`.

The old translucent hologram is now an opaque board with a wooden backing, stone posts and a 4.9 × 0.7 × 0.46 m stone plinth. These are render meshes only. `townSolids` still derives all solids from `TOWN_LAYOUT` at `packages/shared/src/planet/town.ts:94`; the separate `hall_wall` world object has no stand collider. Its center is clear of the Hall building's collider.

Confirmed with the actual `QuestWorld` transform at town coordinates `(-20.8, -12)`. At the middle of the plinth, the shared collider reports `resolve=false`, zero push and `footing.inside=false`. The real `PlayerController` settles with its feet inside the stand rather than on its 0.7 m top. Through `/api/play` and the SDK, an admin teleport there followed by 20 controller input frames yields **0 corrections**, and the replicated player remains at the stand's center. Both sides agree on the same missing collision.

The new test at `apps/client/src/world/unload.test.ts:106` checks that the board's outer corners do not intersect existing town structures. It does not check that the board itself blocks the player. A player can walk through the stone stand or stand inside its backing panel, which is inconsistent with D39's solid town props and the requested board-collider check.

Add shared, indestructible box solids for the plinth, backing and posts in the board's actual inward-facing frame, consumed by the client and server. Keep the authoritative `hall_wall` position. Add a crossing/standing check through the board center and retain the existing approach-clearance test. Do not put the stand into the breakable list.

## Round-1 closures

| Finding | Status | Evidence at reviewed tip |
|---|---|---|
| B1, restored/teleported position correction loop | Closed | `apps/server/src/world/BodyRoom.ts:396`, `:1111`, `:1328`, `:1366`; `apps/server/src/world/quests/QuestSystem.ts:285`; `packages/shared/src/planet/town.ts:169`. Server placement clears structures before initializing motion. Real-path tests at `apps/server/test/town.test.ts:142` and `:166` passed for saves at the keep, Market Hall and Hall of Firsts, plus an admin teleport into the keep. Each drives the real controller for 20 frames, feeds corrections back and requires zero corrections. |
| S1, invisible colliders/late town installation after deadline | Closed | `apps/client/src/render/townAssets.ts:88` bounds requests, body reads and decodes with a 15 s abort; the failed session cache resets at `:80`. `apps/client/src/world/PortusTown.ts:153` selects fallback by 18 s and cannot install a later source completion for that town instance. `apps/client/src/game/Game.ts:439` awaits that settled town before probe and warm-up. Never-arriving and late-arriving source tests passed. |
| S2, fallback cylinder radius doubled | Closed | `apps/client/src/world/PortusTown.ts:402` uses radius 0.5 with full-width instance scaling. The client test checks every fallback instance's transformed extent against its shared solid, including all cylinders. |
| S3, fixed waits did not prove final input processing | Closed | `apps/server/test/town.test.ts:38`, `:55`, `:104` wait for replicated final sequence numbers before detaching correction listeners. The remaining 50 ms waits pace packets. Accepted and refused inputs both update the sequence, `apps/server/src/world/BodyRoom.ts:651` and `:688`. |
| Nit, D38 PROPS_VERSION text | Closed | `docs/DECISIONS.md:411` now records 3 → 4 on top of vegetation's 3. |
| Nit, generated GLB/version comment | Closed | `tools/blender/portus/gen_town.py:34` and `packages/shared/src/content/portusTown.ts:2` identify the manifest as the layout-version carrier. The loader's version check is at `apps/client/src/render/townAssets.ts:107`; this is not runtime verification of all shipped hashes. |
| Nit, stage-1 slot overlaps decorative target | Closed; chosen fix acceptable | `apps/server/src/world/quests/QuestSystem.ts:285` routes stage teleports through `placeBody`. `apps/server/test/town.test.ts:176` passed for every Portus formation size 1–40, checking both inside and residual push, and bounding slot movement below 1.2 m. Selecting a collision-free stage position was explicitly an acceptable round-1 remedy; moving the decorative prop is unnecessary. |

## Requested checks

### Shadow copy

- `PortusTown.ts:285` builds the opaque shadow copy from every non-decal placement, using building LOD1 shells and omitting window-glass triangles. The visible cutout mesh retains alpha-tested shadows. All visible town variants still receive shadows. There are no additional production point/spot shadow lights whose town shadows are lost by this change.
- The shadow mesh uses only layer 5, `PortusTown.ts:321`; the normal view camera remains on layer 0. `apps/client/src/render/atmosphere.ts:258` enables layer 5 on the single-map sun's shadow camera without dropping layer 0. The installed three 0.186.1 `ShadowNode.updateShadow` preserves a shadow camera mask with nonzero extra layers. WebGPU and the WebGL2 fallback both use this common renderer/shadow path. Parent groups need not share the child's layer: the renderer traverses children even when the parent's mask does not match.
- `PortusTown.ts:428` switches back to visible-town casters for cascades. The copy is hidden and does not cast in that mode. Low/no-shadow settings disable casting. The targeted layer/settings test passed. No missing caster was found in static inspection, but shadow silhouette accuracy is not a pixel-level result here.
- `apps/client/src/render/warmup.ts:170` compiles the view, then `:175` renders real pipeline frames including shadows. The layer-5 material is therefore reached by the shadow render behind the loading screen even though the view compile does not draw it. The arrival awaits the town before entering this protocol. Actual GPU compilation and zero post-warm-up builds still require a browser check.
- `PortusTown.ts:510` disposes the shadow geometry on unload, and `:171` handles build failure. The tiny shadow material is an intentional session singleton, like the existing town materials. No per-visit shadow material or texture allocation leak was found.
- The existing shader suite generates the town colour/cutout graphs on WGSL and GLSL; it does **not** directly exercise the new position-only mesh through an actual shadow render. The geometry/settings tests cover structure and layers, not GPU pipeline creation.

### Lamplight factor

`apps/client/src/render/environment.ts:87` is a pure function of night and dusk. `:379` writes the one shared `atmo.lamps` uniform from the existing sky-derived light factors, with no cloud term. `apps/client/src/render/townMaterial.ts:56` is its only material consumer. Thus Portus windows follow the same factor; portal, flame, quest-lamp and other-body lighting retain their existing `glowBoost` behavior. No other body currently creates a town/window material using this factor. This is a shared client rendering uniform, not a new server-authoritative value.

`apps/client/src/render/environment.test.ts:113` passed its late-evening, clear/drizzle daytime and pure-function endpoint assertions. `apps/client/src/render/shaders.test.ts:200` supplies window mode 2 and builds all four town variants on both backends; those tests passed. They cover graph generation, while the environment test covers the factor's behavior. They do not establish visual brightness or pixel output.

### Road subdivision

`apps/client/src/world/townDecal.ts:39` selects triangles reaching beyond 69 m chord, 3 m before the 72 m flat-floor limit. Connected selected triangles receive a common cut count; `:134` lifts their vertices with a smooth 69–75 m ramp. A probe of the shipped paving found **16 shared source endpoints** at the boundary with retained triangles, all at 67.3113–68.9894 m chord. Their added lift is zero, so the retained and subdivided boundary agrees. Subdivision preserves the original linear edge there. No geometric seam gap was found.

The real paving grows from **4,402 to 8,274 triangles**, +3,872, with 9,044 → 12,000 vertices. It is computed once and used for both LODs. The added visible cost is about 2% of the prior Medium town triangle count; the simplified shadow copy excludes paving. `townDecal.test.ts` passed dense samples on both outer roads, with more than 300 pieces per road and at least 1 cm of clearance from rendered terrain. This does not measure frame rate.

### Hall placement and readability

The new board remains at the authoritative position and faces the plaza through `QuestWorld.ts:162`. Its 4 × 3 m text face starts at 0.9 m, with the heading near 3.6 m, and uses an opaque depth-writing canvas plus modest self-light. The targeted opacity, dimensions, approach clearance and disposal tests passed. Collider failure is S4 above.

**FAIL TO VERIFY: visual readability from the plaza.** No game render or screenshot was captured in this round. Geometry, orientation and contrast choices are consistent with the intended fix, but the stub-canvas tests do not render lettering and cannot establish readability at a real viewport/distance.

### placeBody edges and cost

- `BodyRoom.ts:1329` deliberately snaps to terrain/swim ground first. A saved or teleported position on a wall top is relocated to clear ground beside it instead of preserving its elevation. The old join/teleport paths also snapped to terrain, so this changes unsafe lateral placement rather than adding an altitude-preservation regression. Ordinary movement still supports walls and low steps; the shared top/step tests passed. A low step can remain a valid location and the controller settles onto its supported top within the movement budget.
- The search is finite: up to 12 resolving passes plus 60 rings × 24 bearings. On failure `placeBody` falls back to `spawnPoint`; the latter clears once and returns the known-clear spawn ring without recursion. A forced `clearSpot=false` probe on the real server room completed in two clear calls and returned a point outside structures. This exercised the failure branch, not a claim that the shipped layout exhausts every ring.
- A diagnostic scan cleared ground points under all 301 solids, five times, with **0 failures in 1,505 calls**. Observed `clearSpot` p50 was 0.042 ms, p95 0.195 ms, and maximum 3.84 ms on this shared machine. These are sampled placement costs, not a worst-case bound or frame-rate benchmark. The operation runs on join/teleport/staging, not every input frame.
- Mounted collision uses the same player footprint in the controller/validator. Portus is safe everywhere and `HorseSystem.ts:90` refuses summoning in safe zones; normal body travel removes the horse. `HorseSystem.ts:179` also despawns it after a large teleport. No ordinary mounted Portus placement path was found. Other bodies have no structure collider, so `placeBody` returns the old `snapToGround` result and leaves their horse handling alone. A real Arcadia room probe returned identical old/new positions for four inputs, including degenerate inputs. No new mounted-path defect was found; no end-to-end mounted journey was run.

## Validation

Executed in this worktree, in the requested order:

```text
pnpm typecheck
  PASS: shared, server and client

pnpm vitest run packages/shared/src/planet/town.test.ts \
  apps/server/test/town.test.ts \
  apps/client/src/render/environment.test.ts \
  apps/client/src/render/townAssets.test.ts \
  apps/client/src/world/portusTown.test.ts \
  apps/client/src/world/townDecal.test.ts \
  apps/client/src/world/unload.test.ts
  PASS: 7 files, 62 tests, 21.31 s

pnpm vitest run apps/client/src/render/shaders.test.ts
  PASS: 1 file, 27 tests, 3.90 s
```

Total repository checks: **89/89 tests passed in 8 targeted files**, plus typecheck. The four B1 scenarios above were exercised through `/api/play`, SDK seat consumption and real controller feedback in the server test run. No full `pnpm test`, game benchmark, build, public hosting or deployment was run.

Additional review-only diagnostics lived outside the worktree in `/tmp/fl-portus-r2-probe.test.ts`, with `/tmp/fl-portus-r2.config.mts` and results in `/tmp/fl-portus-r2-probe-results.json`. They use the actual shipped GLB, `QuestWorld`, `PlayerController`, shared collider and in-process server. Those diagnostics completed successfully; their single runner case is not included in the 89 repository-test count. The only retained worktree change is this uncommitted report.

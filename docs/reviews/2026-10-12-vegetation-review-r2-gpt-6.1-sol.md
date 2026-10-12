# Vegetation code review, round 2

Reviewed `git diff main...lane/vegetation` in `fl-wt-veg`. Branch tip: `c0e0855fdaa90d8bbc43cd388c818d3b95e775d3`; current main: `3d836f3afdcb3f76006dadfd1b58580dc75f4091`; merge base: `88c3e427934a2167beb8d511482abbd4de28016f`. Read `AGENTS.md`, the round-1 review, implementation report, and relevant specification/asset rules. Included `e7cb36b` and all subsequent fix commits. Standards and rendering/spec checks were independently reviewed, with direct authority probes and the requested validation run.

Report only. No source edits, commits, pushes, browser, deployment, or asset rebuild. The only worktree addition is this uncommitted report.

## Blockers

None found. The round-1 authoritative-layout blocker is closed.

## Should-fix

None remaining from round 1, and none newly established in the fix commits. GPU performance and visual acceptance remain unverified, as described below.

## Nits

None remaining from round 1, and none worth adding.

## Authoritative layout verification

- Executed current main's own shared sources from a temporary `git archive`, and this branch's shared sources with Node 24. Compared the complete ordered results of `bodyBreakables(createTerrain(body))` using deep equality and serialized-byte equality. Portus: **0 / 0**; Arcadia: **220 / 220**; Hollowmere: **166 / 166**; Meridian: **256 / 256**. Every comparison passed. IDs, dense indices, positions, orientation frames, main collider dimensions, compound parts, and all other returned fields are identical. All four SHA-256 values match the committed pins.
- `packages/shared/src/planet/breakables.test.ts:30` pins the full ordered JSON, not counts or selected fields. Mutation probes changed IDs, dense indices, positions, dimensions, compound parts, and order on each nonempty body; every change altered the hash. A further probe applied the same hash assertion to independent mutations of **all 6,710 numeric/string fields** in Arcadia's layout; all 6,710 were rejected. This protects serialized layout data, including part fields and list order.
- Diffed `packages/shared/src/planet/props-v2-frozen.ts` against current main's `props.ts`. The only differences are the four-line explanatory header and renaming `chunkProps` to `frozenV2ChunkProps`. Placement rules, their order, random seeds, masks, exclusions, surface math, kind indices, and collider definitions are faithful copies.
- `packages/shared/src/planet/breakables.ts:770` now uses that frozen placement. Changed visual vegetation yields to the fitted breakable footprints at `packages/shared/src/planet/props.ts:290`; it cannot move or remove authoritative solids.
- Traced other gameplay consumers. Server movement uses destruction footing/sweeps through `apps/server/src/world/BodyRoom.ts:218`; destruction constructs its collider from `bodyBreakables` at `apps/server/src/world/destruction.ts:68`. Shots and NPC sight use that host's raycast through `combat.ts:68` and `npc/attacks.ts:84`, plus existing arena cover. Client movement receives `BreakablesView` at `apps/client/src/world/Breakables.ts:294`. Natural props only reach the terrain worker's packed visual instances and `PropSystem`; their collider definitions supply placement exclusions, not active movement or shot colliders. Player/NPC spawns and quest anchors derive from terrain, pads, arenas, and authored content, without consuming changed natural props. No additional authoritative dependency on the revised vegetation placement was found.

## Fix verification

- **Undergrowth shadows and batch consolidation:** `apps/client/src/render/props.ts:87`, `:161`, and `:204` keep bush, fern, flower, mushroom, scrub, and reed from casting and synchronize retained samples with live tier settings. LOD1 never casts. Rock/boulder variants now share compatible geometry/material batches; boulder scale, tint, deterministic variant selection, and chunks arriving before readiness are preserved. The passing budget tests enforce the revised props-only caps. Whole-scene and cascaded-shadow performance are separate acceptance checks.
- **Atomic installation and fallback:** `apps/client/src/render/vegetationAssets.ts:52` requires both atlases and validates all mapped LODs, required attributes, finite values, and indices before installation. `apps/client/src/render/props.ts:102` prepares clones, materials, and early chunk reclassification before replacing live meshes; preparation failure disposes clones. `:95` catches installation failure and resolves `ready`. Passing missing-node, missing-attribute, mesh-atlas, and impostor-atlas tests confirm every procedural geometry/material survives and the fallback still renders instances.
- **Verified build inputs:** `tools/blender/vegetation/build.sh:13` hashes the archive, extracts it into a fresh temporary directory, and passes that directory to Blender at `:16`. The independent `SRC/x` extraction is no longer imported. `bash -n` passed. No full Blender rebuild was performed.
- **Registry hash:** `docs/ASSETS.md:163` now records the manifest SHA-256. Independently recomputed both shipped hashes; the manifest and GLB match the registry.
- **Per-size triangle limits:** `apps/client/src/render/vegetationAsset.test.ts:65` enforces 900 near / exactly four far triangles for trees and 320 near / 32 far for small models. These assertions decode shipped geometry rather than trusting the manifest.

## Foliage lighting and pipeline verification

`apps/client/src/render/vegetationAssets.ts:108` applies gain 3.6 only to the foliage tint path. Bark, stone, and unmasked paint retain their existing paths. At `:140`, radial world up is transformed into view space with `w=0`; impostors use that normal and near foliage mixes toward it.

Inspected installed Three 0.186.1. `NodeMaterial.setupNormal` enters the `NORMAL` sub-build, where `normalView` resolves the geometry normal with backface correction. The near-foliage expression therefore does not recursively evaluate its own custom normal. Both backend node builders successfully generate all body/model/LOD materials as WGSL and GLSL in `shaders.test.ts`.

Three's shadow override propagates atlas alpha, alpha test, double-sided settings, and the wind `positionNode`, but does not copy `normalNode`. The new normals therefore leave casting silhouettes and wind deformation unchanged. They do change receiving-shadow normal bias, because `ShadowNode` offsets along `normalWorld`. That effect needs visual acceptance, not an additional casting pipeline.

Retained warm-up samples share the live material, geometry attribute layout, instance capacity, and shadow policy at `apps/client/src/render/props.ts:169`. Arrival awaits `props.ready` before warm-up at `apps/client/src/game/Game.ts:430`. The lighting change adds no uncovered material/LOD category or runtime-dependent shader variant. Actual post-warm-up reuse remains unproven without rendering.

## Validation and limits

- `pnpm typecheck`: **passed** for shared, server, and client.
- Targeted `pnpm vitest run`: **129 tests passed across 12 files**, **103.76 seconds**. Included all four `vegetation*.test.ts` files, `shaders.test.ts`, shared props/breakables, and server destruction, movement, prop-climb, prop-cover, and footing. No timeout or failure required an isolated rerun.
- Direct all-body main/branch layout comparison, hash mutation probes, shipped asset hash checks, and build-script syntax check passed.

No browser/GPU execution was performed. Driver compilation, rendered leaf brightness and shadow bias, visual LOD transitions, WebGL2 execution, zero post-warm-up builds after travel/tier changes, whole-scene Medium draw/FPS compliance, and optional cascaded-shadow cost remain unverified. Passing source-generation and props-only CPU tests do not establish those outcomes. The full test suite was not rerun in this review.

Verdict: **merge approved on code-review grounds; browser/GPU visual and performance sign-off remains pending.**

# Vegetation code review

Reviewed `git diff main...lane/vegetation` in `fl-wt-veg`, commits `7b2350a`, `a93dc0c`, `737356f`, and `3997f80`. Branch tip: `3997f809`; current `main`: `c9ddf294`; merge base: `88c3e427`. Read `AGENTS.md` and the implementation report. The reviewer only wrote this untracked report; no source edits, commits, pushes, or browsers.

A concurrent uncommitted foliage-tint change appeared in `apps/client/src/render/vegetationAssets.ts` at 10:47:55, after both test runs completed. It was left untouched and is outside this four-commit review and its validation results.

## Blockers

1. **Changed authoritative layout accepts incompatible live clients.** `packages/shared/src/planet/breakables.ts:770`, `packages/shared/src/planet/props.ts:26`, and `packages/shared/src/planet/props.ts:95`.

   Breakables now yield to the changed natural placement. A direct Node 24 comparison of current `main` and this branch found Arcadia changes from 220 to 218 breakables and Hollowmere from 166 to 161. Arcadia removes `12.11` campwall and `15.5` crate; Hollowmere removes `10.0`, `10.2`, `10.3`, `12.14`, and `14.14`. Surviving IDs retain their positions and collider dimensions; their local dense indices change for 77 Arcadia and 74 Hollowmere entries. Portus and Meridian breakable lists remain unchanged.

   An old client still renders and predicts collision/support against those seven removed objects. The new server uses its different list for movement footing, shots, and NPC sight. The reverse deployment order makes the new client omit objects the old server still treats as solid. Bumping `PROPS_VERSION` to 3 documents the change but does not enforce agreement: production code never consumes it. `PROTOCOL_VERSION` remains 2 at `packages/shared/src/net/protocol.ts:24`, and `/api/play` only checks that value at `apps/server/src/app.ts:131`. The implementation report's instruction to release both together does not make separate rolling deployments compatible.

   **Suggested fix:** Preserve the v2 authoritative breakable layout by using frozen v2 solid-prop placement for its exclusions, and keep the new visual vegetation yielding to that layout. Alternatively, version the authoritative layout in admission and room/reconnect handling, reject incompatible builds, and provide a rollout that drains old rooms and serves a matching client. An admission-only version bump does not cover existing connections or token reconnections. Add a regression comparing old/new supported layouts or exercising mismatched-build admission and reconnects.

## Should-fix

1. **Small undergrowth pays a shadow draw for every near variant.** `apps/client/src/render/props.ts:122`, with matching warm-up behavior at `apps/client/src/render/props.ts:136`.

   Every LOD0 batch casts shadows when map shadows are enabled, including fern, flower, mushroom, bush, scrub, and reed. The report measures Medium props rising from 12 to 34 draws and High from 12 to 45, including one shadow pass. That adds pressure to a whole scene already reported at roughly 290 draws against Medium's 250 budget. Optional cascades add further passes; the CPU budget test counts only one. Testing props alone against the entire scene budget at `apps/client/src/render/vegetationBudget.test.ts:50` cannot establish whole-scene compliance.

   **Suggested fix:** Disable casting for small undergrowth, apply the same policy to retained warm-up samples, and recount the sampled views. Consolidate compatible variant batches where practical. Before performance sign-off, measure whole-scene draws/FPS and the optional cascaded configuration; the existing CPU counts cannot establish the GPU result.

2. **An incomplete but parseable GLB aborts arrival instead of preserving fallback.** `apps/client/src/render/props.ts:90` and `apps/client/src/render/props.ts:103`.

   `preloadVegetation()` catches download/parse errors, but `installAssets()` runs outside that catch. If a mapped node is missing, installation throws after earlier meshes may already have replaced and disposed their procedural geometry. The rejected `ready` promise then escapes through `apps/client/src/game/Game.ts:430`. The current shipped GLB contains the required names; this defect concerns incomplete or mismatched asset releases.

   **Suggested fix:** Validate every required LOD, attribute, and atlas before replacing any live geometry, prepare replacements atomically, and handle installation errors by retaining the complete procedural set. Require the impostor atlas for the shipped tree-card UVs rather than silently substituting the mesh atlas. Add a missing-node/missing-atlas fallback test that asserts `ready` resolves and the fallback remains usable.

3. **The source hash does not pin the files Blender actually imports.** `tools/blender/vegetation/build.sh:10` and `tools/blender/vegetation/build.sh:11`.

   The script validates `SRC/download.zip` but imports the independent extraction at `SRC/x`. Editing or replacing an extracted glTF, BIN, or PNG leaves the archive check green while changing the generated asset's provenance. The current extraction matches the archive, so this is a reproducibility gap, not evidence of a non-CC0 shipped file.

   **Suggested fix:** Extract the verified archive into a fresh temporary directory and import from it, or verify every consumed member against the archive before invoking Blender.

## Nits

1. **Manifest hash missing from the registry.** `docs/ASSETS.md:162`.

   The SHA-256 cell says "generated alongside the GLB" instead of recording the required hash. Replace it with `cf608802bb22feaeac244b0e1fc9b7622eb1fb481be9dc5c0919c08e5bbb63b4`.

2. **Geometry tests allow oversized small props.** `apps/client/src/render/vegetationAsset.test.ts:36`.

   Every model gets a 900-near/96-far triangle allowance, although the build and registry promise 320-near/32-far for small props. A costly undergrowth rebuild can pass this assertion.

   **Suggested fix:** Use separate tree and small-prop caps, retaining the exact four-triangle assertion for tree impostors.

## Verified behavior and limits

- The original ten `PROP_KINDS` indices and all existing `PROP_DEFS` values are unchanged. Fern, flower, and mushroom are appended with `collider: "none"`.
- Same-build placement remains deterministic. The two-stage call graph avoids recursive props/breakable generation. The blocker is mixed-build compatibility, not a demonstrated same-build server/client disagreement.
- Variant/LOD selection, packed-yaw wind phase, and retained warm-up sample layouts/capacities are consistent. Static inspection of the installed three r186 code supports instance-transform ordering and propagation of alpha-cutout, double-sided, and wind settings into shadows. Live instance buffers are disposed on travel; retained samples and cached templates/materials intentionally survive. No additional disposal or tier-change defect was established.
- The local source archive hash and shipped GLB hash match `docs/ASSETS.md`. The supplied licence names Quaternius and CC0 1.0; extracted glTF-directory files match the archive. Author, source URL, licence, date, and changes are recorded. No non-CC0 addition found.
- The real-GLB helper caches decoding, strips image/material references, and needs neither HTTP nor a DOM image decoder. It meaningfully checks shipped geometry. Shader tests generate both WGSL and GLSL for every body. They do not execute driver compilation, validate rendered shadows, or prove zero builds after warm-up.
- GPU performance, visual LOD transitions, WebGL2 execution, and `?shadercheck` after initial warm-up, travel, and tier changes remain unverified because this review did not open a browser.

## Validation

- `pnpm typecheck`: passed for shared, server, and client.
- `pnpm vitest run` with the four `vegetation*.test.ts` files, `shaders.test.ts`, shared `props.test.ts` and `breakables.test.ts`, and server `destruction.test.ts`, `movement.test.ts`, `prop-climb.test.ts`, `prop-cover.test.ts`, and `footing.test.ts`: **119 tests passed across 12 files**, 89.84 seconds. No timeout or failure required an isolated rerun.
- A focused timing run of vegetation asset/model and shader tests: **31 tests passed across 3 files**, 4.52 seconds. The real-GLB geometry-validation test took 45 ms; vegetation source-generation cases took 1.28 seconds for WGSL and 1.62 seconds for GLSL. No decoding-related flakiness or excessive latency found.
- Compared both builds' real `bodyBreakables(createTerrain(body))` results using Node 24, including IDs, transforms, collider sizes, and compound parts.

Verdict: **do not merge** until the authoritative layout compatibility blocker is resolved.

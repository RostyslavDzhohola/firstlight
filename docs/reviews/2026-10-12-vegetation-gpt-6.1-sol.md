# Vegetation implementation

Branch `lane/vegetation`, worktree `fl-wt-veg`, based on `88c3e42`. Local implementation only;
no browser, external service, push, merge or deployment was used.

## Models and planet looks

Every kind has an explicit mapping on every body. This table lists the kinds actually placed by
that body's shared biome rules. Other kinds retain a complete mapping if a future rule uses them.

| Body | Kind | Pack model variants |
|---|---|---|
| Portus | blossom | CommonTree_1–3, pink foliage |
| Portus | bush, flower | Bush_Common / Bush_Common_Flowers; Flower_3_Group / Flower_4_Group |
| Portus | rock | Rock_Medium_1–3 |
| Arcadia | oak, pine | CommonTree_1–3; Pine_1–3 |
| Arcadia | bush, fern | Bush_Common / Bush_Common_Flowers; Fern_1 |
| Arcadia | flower, mushroom | Flower_3_Group / Flower_4_Group; Mushroom_Common / Mushroom_Laetiporus |
| Arcadia | rock, boulder | Rock_Medium_1–3, boulders scaled to 2.3 m |
| Hollowmere | oak, deadtree | TwistedTree_1–3; DeadTree_1–3 |
| Hollowmere | reed, fern, mushroom | Plant_1_Big / Plant_1; Fern_1; Mushroom_Common / Mushroom_Laetiporus |
| Hollowmere | rock, boulder | Rock_Medium_1–3 |
| Meridian | scrub | Plant_7 / Plant_7_Big |
| Meridian | rock, boulder | Rock_Medium_1–3 |
| Meridian | spire | existing procedural banded rock spires |

Portus uses pink blossom trees and fresh green undergrowth; Arcadia lush green; Hollowmere olive
leaves, violet bark/stone and a mixture of twisted and dead trees; Meridian dry ochre foliage and
red stone. The existing body prop palettes, alongside `looks.ts` grading, supply the TSL tints.
Flower and mushroom paint stays intact. Wet weather darkens surfaces and lowers roughness.

Packed Float32 yaw is the existing per-prop seed. Hashing it selects a variant identically on all
clients, and supplies a stable wind phase across chunk uploads, LOD switches and tier changes.
The packed stride remains six floats. Models are instanced by variant and LOD; their materials
use opaque, double-sided alpha cutouts at 0.5. Height-weighted TSL wind preserves r186's instance
transform and uses no compute/storage features, so the same code supports WebGL2.

The GLB loads before the quality probe and shader warm-up. Failure keeps the procedural fallback.
Every variant/LOD has a retained instanced warm-up sample with matching attributes and instance
capacity, placed inside the camera-local shadow map. Only near trees, rocks and spires cast
shadows; small undergrowth never casts. Samples follow the same tier policy as live meshes. Normal
chunk and distance culling, upload signatures, instance colours and the trees feature toggle remain.

## Shared placement and collision

`PROPS_VERSION` is now 3. The original ten kind indices, packed format and `PROP_DEFS` collider
radii/heights/types are unchanged. Fern, flower and mushroom are appended with no collider.
Arcadia oak probability rises from 0.50 to 0.60, pine from 0.45 to 0.50; forest bushes become
more frequent, and ferns, flowers and mushrooms share the oak clump mask. Hollowmere gains
masked twisted trees, ferns and mushrooms around its dead-tree clumps. Meridian stays sparse.

Breakables yield to the frozen v2 natural-prop placement copied from `main` at `c9ddf29` in
`packages/shared/src/planet/props-v2-frozen.ts`. Visual vegetation then yields to those unchanged
breakable footprints. The frozen copy keeps its original rules, rule order, masks, clearings,
surface math and collider definitions. `PROPS_VERSION` versions visuals; it is not a layout gate.

Natural-prop collider definitions only supply placement exclusion radii. They are not active
client-only colliders: the terrain worker sends the packed visual instances to `PropSystem`,
which renders them. The client controller's collision/support provider is `world/Breakables.ts`,
using `BreakableCollider`. Server movement footing, shot occlusion and NPC sight use
`world/destruction.ts` and its `bodyBreakables` list, plus existing arena cover. Neither side
collides with or stands on natural trees/rocks. Changing their visual placement therefore changes
scenery without changing gameplay solids. Old/new clients and servers keep the same authoritative
breakable IDs, dense indices, transforms and compound colliders in either deployment order.
Portus walkways lie inside the existing 48 m plaza clearing. No separate path geometry exists on
the other bodies in this base revision.

## Assets

Quaternius Stylized Nature MegaKit Standard, CC0 1.0, source and archive hash recorded in
`docs/ASSETS.md`. Offline build: `tools/blender/vegetation/build.sh`.

- `apps/client/public/assets-dev/vegetation/vegetation.glb`: 2,353,020 bytes, meshopt compressed.
- `manifest.json`: 3,821 bytes; total installed output 2,356,841 bytes.
- 26 models, two LODs each. Two embedded PNG atlases, 2048² for meshes and 1536×1024 for tree
  impostors. No new runtime dependency or network-based build step.
- Near trees at most 900 triangles; near small models at most 320. Tree impostors have four
  triangles; far small models at most 32. All templates total 14,489 near and 491 far triangles.
- Role-mask export and normalized integer transform baking have regression coverage. Transform
  baking expands quantized attributes to Float32 before applying glTF node transforms.

`2026-10-12-vegetation-lods.png` is a headless Blender style check, with near models in the front
row and crossed impostors behind. It is an asset check, not a screenshot of the game's lighting.

## CPU budget comparison

Identical 16 views, four per body: an axial view, an inland view, a cube seam and the main-pad
approach. Real terrain/chunk placement and actual decoded GLB geometry are counted. Draws and
triangles include one shadow pass for each populated near shadow-casting batch, ignoring shadow
frustum rejection. Maxima for each column can come from different views. The baseline ran the
`88c3e42` placement and renderer from temporary test helpers, removed after measurement.

| Tier | Before max instances | After max instances | Before max triangles | After max triangles | Before max draws | After max draws |
|---|---:|---:|---:|---:|---:|---:|
| Low | 773 | 340 | 21,698 | 6,422 | 7 | 16 |
| Medium | 1,539 | 666 | 45,142 | 58,615 | 12 | 26 |
| High | 2,270 | 1,283 | 69,564 | 133,546 | 12 | 35 |
| Ultra | 3,100 | 1,646 | 100,576 | 163,314 | 15 | 38 |

Low uses far LODs at every distance and stops at 110 m, previously 15/140 m. Medium uses detailed
meshes to 20 m and far meshes to 150 m, previously 25/180 m. Small undergrowth stops at 65 m on
all tiers. High and Ultra keep their tree/rock distances. These changes offset model cost and the
added undergrowth. Fewer total instances mostly reflect the shorter ranges, particularly reeds;
forest tree/clump density and nearby undergrowth increase.

The permanent budget test covers these views and caps Medium's props at 1,000 instances,
120,000 triangles and 30 draws. The whole-scene tier budget remains 250 draws. The supplied
previous bench already reported about 290 draws and 1.05 M triangles, so these CPU checks cannot
establish that the whole scene meets the 250-draw budget or 60 fps. The measured vegetation maxima
add 14 draws and about 13.5k triangles relative to the baseline; camera-specific differences vary.
Cascaded-shadow work on opt-in High/Ultra is not included in this single-shadow-pass count.

## Validation

Targeted tests cover mapping completeness, packed-yaw determinism, real GLB decoding, atlas and
compression/size constraints, root/scale and triangle limits, role masks, retained warm-up layouts,
wind-phase/LOD/tier stability, real-terrain tier budgets, terrain/pad/plaza/arena/portal/interaction/
breakable exclusions, forest undergrowth proximity and unchanged collider dimensions.

Original implementation validation results, before Round 1 fixes:

- `pnpm typecheck`: passed.
- `pnpm --filter @firstlight/client build`: passed.
- Targeted vegetation/model/asset/budget tests: 14 passed. Shared props and breakables: 21 passed.
- `pnpm test`, one full run: 1,071 passed, two failures across 114 files. The quality-table assertion
  still expected the previous full-mesh distances; it now matches the updated SPEC table. The
  server idle-fall movement test timed out under the full-suite load.
- Isolated reruns: `shaders.test.ts` 25/25 passed, including real vegetation/impostor WGSL and GLSL
  generation on every body; `movement.test.ts` 38/38 passed without changing server code or its test.
  Every failure from the full run is resolved or passes alone. The full suite was not repeated.
- The headless Blender style check was rendered and inspected locally. No browser or GPU shader
  execution was used.

The shader checks build source with three's real node builders, including lights and shadow
receiving. They do not validate the driver's shader compiler or post-warm-up pipeline reuse.

## Browser handoff

Still unverified without a browser: per-planet visual grading and leaf/bark colours, alpha-card
edges and shadow silhouettes, near/far popping and intersecting impostor views, gentle wind on
both backends, zero post-warm-up builds with `?shadercheck`, travel/graphics-change shader reuse,
and `?bench=g1` FPS/draw/triangle totals on the M1 at Medium. Also check `?webgl&tier=low`.
Use `?offline&body=arcadia&tier=medium&shadercheck`, then change `body` to each other planet. No 60 fps or shadercheck result is claimed.

## Commits

- `7b2350a`: offline CC0 pack build, meshes, atlases and impostors, asset provenance.
- `a93dc0c`: shared clumped placement, exclusions, unchanged collider definitions and model mapping.
- `737356f`: tinted instancing, wind, loading/warm-up, quality distances, real-asset budgets and
  WGSL/GLSL source generation.
- This report and the headless preview are saved in a separate documentation commit.

## Round 1 fixes

Addressed `docs/reviews/2026-10-12-vegetation-review-gpt-6.1-sol.md` on `lane/vegetation`.
The builder's `e7cb36b` foliage gain of 3.6, sky-facing impostor normal and 65 percent near-leaf
normal mix remain unchanged. No browser, push, merge or deployment was used.

1. Authoritative layout is pinned to `c9ddf29`. The regression hashes the full ordered JSON result
   of `bodyBreakables(createTerrain(body))` for all four bodies, including every collider field.
   Expected hashes were generated by executing main's own code from a temporary git archive,
   not from the revised placement. Counts are Portus 0, Arcadia 220, Hollowmere 166 and Meridian 256.
   Visual vegetation still yields to this layout. Natural-prop collision consumers and deployment
   consequences are documented in the shared placement section above.
2. Bush, fern, flower, mushroom, scrub and reed never cast shadows. Retained warm-up samples follow
   the live settings, including Low/Medium/High changes. Rock and boulder variants share one batch
   per model/LOD, with boulder scale and stone tint carried in instance data. Different tree and
   undergrowth model geometries remain separate. Chunks arriving before asset readiness are
   reclassified before installation commits. Tests pin the shared batch, scale and paint.
3. Installation validates every mapped LOD in the whole pack, position/normal/UV/role attributes,
   finite attribute values, triangle indices and both atlases. Geometry clones, materials and early
   chunk data are prepared before replacement. Failure warns, resolves `ready` and preserves every
   procedural geometry/material. Missing-node, missing-attribute, mesh-atlas and impostor-atlas
   regressions exercise that fallback. Tree-card LOD1 requires its impostor atlas.
4. The offline build extracts the hash-checked archive into a fresh temporary directory and imports
   from that directory. An intercepted Blender invocation confirmed the imported glTF matches the
   archive even with a bogus `SRC/x` extraction present. Failure cleanup also passed with the pack's
   read-only directory modes. `bash -n` passed. A full Blender rebuild was not repeated.
5. The registry records the recomputed manifest SHA-256, unchanged at
   `cf608802bb22feaeac244b0e1fc9b7622eb1fb481be9dc5c0919c08e5bbb63b4`.
   Asset tests now cap trees at 900 near / exactly four far triangles and small models at
   320 near / 32 far triangles.

Recounted the same 16 views with the restored authoritative layout. The instance maxima remain
unchanged in these views. The comparison below uses the pre-fix vegetation renderer, not the
original procedural baseline from the earlier table. All counts include one shadow pass and
ignore shadow frustum rejection.

| Tier | Max instances before / after | Max triangles before | Max triangles after | Max draws before | Max draws after |
|---|---:|---:|---:|---:|---:|
| Low | 340 / 340 | 6,422 | 6,422 | 19 | 16 |
| Medium | 666 / 666 | 61,303 | 58,615 | 34 | 26 |
| High | 1,283 / 1,283 | 139,736 | 133,546 | 45 | 35 |
| Ultra | 1,646 / 1,646 | 184,233 | 163,314 | 50 | 38 |

Round 1 validation results:

- `pnpm typecheck`: shared, server and client passed.
- Targeted `pnpm vitest run`: 129 tests passed across 12 files in 91.78 seconds. Includes every
  `vegetation*.test.ts`, `shaders.test.ts`, shared props/breakables and server destruction,
  movement, prop-climb, prop-cover and footing tests. No timeout or isolated retry was needed.
- Both CPU budget measurement runs passed; the final targeted run reproduced the after table.
- Frozen source comparison confirmed an exact copy of main's v2 file apart from its header and
  placement function name. All-body full-layout hashes passed.
- Build script syntax and the archive/extraction/failure-cleanup probe passed.
- Full `pnpm test`, exactly one run: 1,068 passed and 16 failed across 114 files in 350.88 seconds.
  Failures appeared in 11 files. The shared layout/weather/props/terrain cases and the High
  vegetation budget exceeded timeouts; server files also failed timing, reward or cost assertions.
- Reran all 11 failed files individually, sequentially. Breakables 13/13, weather 11/11,
  horses 15/15, egg behavior 15/15, moderation 12/12, movement 38/38 and NPC benchmark 1/1 passed.
  Shared props still had six 5-second timeouts, 3/9 passed. Terrain had one 5-second timeout and
  a sampling-cost failure, 6/8 passed; 100k samples took 2,966.5 ms against a 400 ms limit.
  Egg persistence still had a reward-count assertion and a wait timeout, 14/16 passed.
  A final bounded retry after the budget fixture work passed props 9/9 in 2.82 seconds,
  terrain 8/8 in 0.687 seconds and egg persistence 16/16 in 20.10 seconds. No code or timeout
  settings in those three files were changed. The causes of the earlier failures remain unisolated.
  All 11 files that failed the full run now pass individually, 142 tests total, using the final
  revised budget test result below.
- The first isolated budget run also timed out on High at 30.36 seconds. Its count assertions
  passed. The revised test reuses deterministic terrain/chunk fixtures across tiers and allows
  60 seconds per tier, preserving every count limit. The revised file passed 4/4 in 5.48 seconds
  and reproduced every value in the after table.
- A final `pnpm typecheck` after the fixture change passed for all three packages.

The machine was heavily loaded by other processes during these runs. That observation does not
establish the cause of each failed assertion. The full suite is not claimed green, and was not
repeated. No server or terrain implementation was changed to chase these failures.

Whole-scene draw/FPS compliance, optional cascaded-shadow GPU cost, driver compilation,
WebGL2 execution, visual LOD transitions and post-warm-up shader reuse remain unverified.
CPU counts and WGSL/GLSL source generation do not establish those results.

Round 1 implementation commits:

- `6daa9a2`: frozen v2 exclusions and all-body authoritative layout hashes.
- `841740b`: atomic pack validation/installation and procedural fallback regressions.
- `84b2e57`: undergrowth shadow policy, matching samples, shared rock/boulder variants and geometry caps.
- `8baf923`: archive-derived build inputs, failure cleanup and manifest hash registry.
- `0826104`: reused deterministic budget fixtures and a per-tier timeout for this counts-only test.

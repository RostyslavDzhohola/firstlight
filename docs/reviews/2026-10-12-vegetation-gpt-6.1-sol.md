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
capacity, placed inside the camera-local shadow map. Only near meshes cast shadows. Normal
chunk and distance culling, upload signatures, instance colours and the trees feature toggle remain.

## Shared placement and collision

`PROPS_VERSION` is now 3. The original ten kind indices, packed format and `PROP_DEFS` collider
radii/heights/types are unchanged. Fern, flower and mushroom are appended with no collider.
Arcadia oak probability rises from 0.50 to 0.60, pine from 0.45 to 0.50; forest bushes become
more frequent, and ferns, flowers and mushrooms share the oak clump mask. Hollowmere gains
masked twisted trees, ferns and mushrooms around its dead-tree clumps. Meridian stays sparse.

Natural props currently influence breakable placement; player movement, support, shots and NPC
sight use the breakable colliders. Shared code is imported by the client worker and server.
Two placement stages avoid recursive generation: natural solid props are placed with pad, plaza,
arena, portal and quest interaction clearings; breakables yield to those props; final vegetation
then yields to the fitted breakable footprints, including non-colliding plants. Removing natural
props can change which breakable slots fit, so server/client releases must carry this shared version
together. Existing breakable-placement and server regression tests cover the resulting layout.
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
triangles include one shadow pass for every populated near batch, conservatively ignoring shadow
frustum rejection. Maxima for each column can come from different views. The baseline ran the
`88c3e42` placement and renderer from temporary test helpers, removed after measurement.

| Tier | Before max instances | After max instances | Before max triangles | After max triangles | Before max draws | After max draws |
|---|---:|---:|---:|---:|---:|---:|
| Low | 773 | 340 | 21,698 | 6,422 | 7 | 19 |
| Medium | 1,539 | 666 | 45,142 | 61,303 | 12 | 34 |
| High | 2,270 | 1,283 | 69,564 | 139,736 | 12 | 45 |
| Ultra | 3,100 | 1,646 | 100,576 | 184,233 | 15 | 50 |

Low uses far LODs at every distance and stops at 110 m, previously 15/140 m. Medium uses detailed
meshes to 20 m and far meshes to 150 m, previously 25/180 m. Small undergrowth stops at 65 m on
all tiers. High and Ultra keep their tree/rock distances. These changes offset model cost and the
added undergrowth. Fewer total instances mostly reflect the shorter ranges, particularly reeds;
forest tree/clump density and nearby undergrowth increase.

The permanent budget test covers these views and caps Medium's props at 1,000 instances,
120,000 triangles and 40 draws. The whole-scene tier budget remains 250 draws. The supplied
previous bench already reported about 290 draws and 1.05 M triangles, so these CPU checks cannot
establish that the whole scene meets the 250-draw budget or 60 fps. The measured vegetation maxima
add 22 draws and about 16k triangles relative to the baseline; camera-specific differences vary.
Cascaded-shadow work on opt-in High/Ultra is not included in this single-shadow-pass count.

## Validation

Targeted tests cover mapping completeness, packed-yaw determinism, real GLB decoding, atlas and
compression/size constraints, root/scale and triangle limits, role masks, retained warm-up layouts,
wind-phase/LOD/tier stability, real-terrain tier budgets, terrain/pad/plaza/arena/portal/interaction/
breakable exclusions, forest undergrowth proximity and unchanged collider dimensions.

Validation results:

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

# Portus castle town in the game — lane/portus-village (Opus 5.5)

Brief: put the winning Portus town design into the game: a new player spawns inside the walled
castle town, it is solid to walk into, and it holds the frame-rate targets. Branch
`lane/portus-village` (from main 6d69731, main merged back in after the vegetation lane, 661a00b).
Nothing pushed, merged into main or deployed. No browser was driven (owner rule); the browser
check list for the builder is at the end.

## What was built

| Layer | Files | What it does |
|---|---|---|
| Asset pipeline | `tools/blender/portus/build.sh`, `extract.py`, `build.py`, `pack.py`, `gen_town.py`, `preview.py` | Verifies both kit archives' SHA-256, extracts only `glTF/` + licence (data only) into a fresh temp folder, runs the design build headless (Blender `--disable-autoexec --factory-startup`), packs it, meshopt-compresses with the pinned gltf-transform, generates the shared data and the manifest, checks ≤ 6 MB. `preview.py` renders the **packed** town in Blender. |
| Shipped asset | `apps/client/public/assets-dev/portus/` | `portus.glb` (58 nodes: 46 prefabs + 12 LOD1, 2 materials), `portus_color.webp` / `portus_normal.webp` (16 layers of 512²), `manifest.json`. **2,797,910 bytes.** |
| Shared data | `packages/shared/src/content/portusTown.ts` (generated) | 46 prefabs with collider solids, 215 placements, streets/areas/plaza/portal floors, fixed features, `PORTUS_TOWN_VERSION`. |
| Shared code | `planet/terrain.ts`, `planet/town.ts`, `planet/townFrame.ts`, `planet/townGround.ts`, `planet/collide.ts`, `planet/breakables.ts`, `planet/props.ts` | Flat town floor to 72 m; placement in the game's pole frame; `StructureCollider` (resolve / raycast / footing / crosses) on the breakable collider code generalised to `SolidFrame`; render-only ground masks for grass and natural props. |
| Server | `apps/server/src/world/BodyRoom.ts`, `movement.ts` | The movement world combines breakables and structures: tops hold feet, inside and crossing are refused. |
| Client | `render/townAssets.ts`, `render/townMaterial.ts`, `world/PortusTown.ts`, `world/Planet.ts`, `game/PlayerController.ts`, `game/Game.ts`, `game/CombatClient.ts`, `render/grass.ts`, `world/terrain.worker.ts` | Loads and validates the asset, bakes the town into merged meshes, LOD per tier, horizon culling, warm-up hook, stone-box fallback; controller collides with the shared solids; tracers stop at walls; grass skips paving/streets/footprints. |
| Deploy gate | `packages/shared/src/net/protocol.ts` | `PROTOCOL_VERSION` 2 → 3 (D40). |
| Docs | `docs/ASSETS.md`, `docs/DECISIONS.md` D38–D41, this file, two packed-asset renders | |

### The previous agent's uncommitted files

`build.py` (kit paths from args/env, `town_extra.json`) and `extract.py` were good and kept.
`pack.py` had never run; it ran end to end on the first try. Changed: the cutout mask moved into the
colour strip's alpha and the normal strip became opaque RGB (a browser canvas decode zeroes RGB
where alpha is 0: with the mask in the normal strip, leaf edges would have sampled (0,0,0) normals);
building LOD1 also drops vine patches; the full slot table goes into `pack_report.json`.
`build.py` now uses the game's exact fixed features: portals at the real arc 16.928 m (`portals.ts`
puts them 17 m out on the tangent plane, 7 cm closer than the design assumed) and the dummies in the
game's order (the design had the row mirrored; same bounding box). The design build is
reproducible: every prefab GLB is byte-identical to `/tmp/fl-village-src/prefabs` except the paving.

## Decisions (full text in DECISIONS.md)

- **D38 — the town and its floor.** Town frame = the game's pole frame (east −X, north +Z,
  geodesic like `places.offsetDir`); the design's frame is the same rotated 180° about Y, which the
  shared code applies. The floor is flat out to **72 m**, not 50: the castle ward and its far towers
  reach 64–69 m. Rim and hills start beyond; terrain is identical from 132 m on (tested against the
  old formula). Spawn, pads, portals, Juno, Hall wall and dummies were on flat ground before
  (≤ 28 m), so none moved. Portus still has 0 breakables. Natural props: none inside 52 m, none
  within 3 m of paving, roads or structures, none under town trees; render-only (Portus props feed
  nothing authoritative; breakables read the frozen v2 copy). `PROPS_VERSION` 3 → 4.
- **D39 — shared, indestructible structure colliders.** 301 solids (boxes/cylinders), hand-authored
  where a footprint box would be wrong (gates, portal courts, stairs, steps, stalls, small props),
  ground-footprint boxes elsewhere. Never in the breakable list. Gate passages 3.8 m wide (2.2 m for
  the body's centre between the open doors); castle gate 3.4 m. Shots/sight: client tracers stop at
  walls; the server's shot and NPC paths don't consult them because Portus refuses shots (safe zone)
  and has no NPCs — `StructureCollider.raycast` exists for a later need.
- **D40 — deploy order: client first, server right after, `PROTOCOL_VERSION` 3.** See below.
- **D41 — rendering.** Two materials over two 16-layer texture arrays; the whole town baked into one
  merged mesh per material and LOD. 2 draws + 2 shadow draws on Medium.

## Deploy order (D40)

- **Old client on the new server:** the old client still walks the old bowl rim (up to 7 m above
  the new floor between 28 and 72 m). The server sees it hovering → height refusals and pull-downs,
  constant rubber-banding; it also walks into houses it doesn't draw → prop refusals. Inside the
  plaza (< 28 m) only the stalls, crates, lamps and courts would correct it.
- **New client on the old server:** its floor is up to 7 m below the old rim → ground refusals from
  ~32 m out, so it can't leave the plaza; around buildings it is just stricter (no corrections).
  Spawn, portals, Juno, dummies and the plaque all work.
- Without a version gate the first case lasts for every open tab until it reloads. With
  `PROTOCOL_VERSION` 3, after the server deploy those tabs rejoin, get 409 and reload once into the
  new client.
- **Order:** assets + client (Vercel) first, then the server immediately (one batched deploy, D9).
  In the gap only fresh page loads fail to join (409, one reload, then an error); current players
  keep playing on the old pair until the server deploy disconnects them. Server-first would lock
  every reconnecting player out until the client lands.

## Numbers

**Download:** 2,797,910 bytes (GLB 2,369,240; colour strip 167,220; normal strip 255,836; manifest
5,614), loaded only on Portus, started when the Portus planet is created (before the room join and
terrain streaming), awaited before the quality probe and the warm-up. Gzip-able GLB ≈ 1.0 MB on the
wire.

**Draws and triangles the town adds** (unit test `world/portusTown.test.ts`: the real baked meshes,
three's frustum against four eye-height views — spawn → keep, the design's `plaza_eye` (0, −6) →
north, spawn → east gate, spawn → south; shadow draws = casters near the player):

| Tier | Draws | Shadow draws | Triangles drawn | LOD | Normal maps |
|---|---:|---:|---:|---|---|
| Low | 2 | 0 | 146.2k | LOD1 always | off |
| Medium | 2 | 2 | 198.2k | LOD0 unless 60 m beyond the town's bounds | on |
| High | 2 | 2 | 198.2k | 90 m | on |
| Ultra | 2 | 2 | 198.2k | 140 m | on |

Same at every view (one merged cell; the shadow pass draws the same two meshes). Cell sizes
measured before choosing one cell (Medium, spawn views): 24 m → 31–34 + 28 shadow; 32 m → 19–23 + 19;
48 m → 14–15 + 14; 64 m → 8–12 + 10; 96 m → 6 + 8; one cell → 2 + 2. Frustum culling saved under
15 % of the triangles from the plaza, so one cell wins. **Before:** the town adds these to the
existing Portus scene (F10: ~290 draws on Medium); grass draws should drop a little (no blades on
paving or under buildings, empty grass cells are hidden), not measured.

GPU memory (estimate): merged vertex + index buffers ≈ 20 MB (both LODs), texture arrays 2 × 22 MB
(16 × 512² RGBA8 with mips).

## Tests

New: `shared/planet/town.test.ts` (12: frame alignment with the game's portals, Juno, Hall wall,
dummies; orthonormal frames on the ground; determinism; 0 breakables; spawn ring clear; portals 4 m
clear and reachable; Juno/plaque/dummies reachable; every street walkable end to end through both
gatehouses and the castle gate; houses/halls/keep/towers/walls block with push-out; steps and wall
tops support feet; rays stop at the keep), `townGround.test.ts` (grass and prop masks; natural props
off roads and out of town), `terrain.test.ts` (flat floor, unchanged far terrain, gentle rim),
`server/test/town.test.ts` (real input path: walking into a house is corrected and never ends inside;
east street through the gatehouse and castle street into the ward get 0 corrections),
`client/render/townAssets.test.ts` (manifest version, sizes, SHA-256, WebP dimensions, meshopt
decode, every prefab and LOD node with the layout's triangle counts),
`client/world/portusTown.test.ts` (materials, budget per tier, LOD/horizon, fallback),
`client/render/shaders.test.ts` (town opaque/cutout × normals/flat on WebGPU and WebGL2, sampling
texture arrays), `client/game/PlayerController.test.ts` (controller stops at a house wall).

Results: see "Final run" below.

## What is unverified

- **Everything in a browser.** The look under the game's sky, sun, fog and grade (materials were
  tuned only by reusing the kit's colours and per-material roughness; the Blender render of the
  packed asset — `2026-10-12-portus-village-packed-plaza.jpg` — matches the design's `plaza_eye.png`
  in shape, textures and tints), frame rate (`?bench=g1`, F11), and `?shadercheck` = 0 builds after
  warm-up on WebGPU and WebGL2.
- **Texture arrays at runtime:** sRGB `DataArrayTexture` upload + mipmaps on both backends, and the
  WebP → canvas decode (Safari private browsing adds canvas read-back noise: tiny colour noise only).
  Shader generation for both backends is tested; upload is not.
- Paving decal vs terrain: 2–7.5 cm above a floor that sags ≤ 1 cm; the outer road ends (70–84 m)
  are lifted onto the rising rim per vertex. Watch for z-fighting at distance and at the road ends.
- The quality probe now renders the town: some machines may now probe one tier lower.
- `?bench` camera path: its figure-eight (r 34 m) and the crowd pass through houses; numbers are
  comparable before/after but some frames are inside walls. Re-baseline if needed.
- Wall-walks and wall stairs are solid blocks (not walkable), as the design notes suggest.
- The keep's and Hall of Firsts' front steps read 0.44 m at their far edge on the curve: players hop
  them (the doors are closed anyway).
- Saved positions inside a house (players who logged out where a house now stands) are pushed out by
  the client on arrival; the server lets a body walk out of a solid it starts in.

## Merge with main

main (vegetation lane, aba1d80) was merged into the lane at the coordinator's request (661a00b):
no conflicts. The Portus exclusions sit in the visual `naturalChunkProps`; `props-v2-frozen.ts` and the
breakable layout pins are untouched (Portus has no sites). Typecheck and the shared, client and
movement server tests pass on the merged branch.

## Browser check list (for the builder)

Run your own stack on free ports (others use 5294/5295): `PORT`, `CLIENT_PORT`, `API_PROXY_TARGET`, `VITE_API_URL`, `CLIENT_ORIGIN`, `BETTER_AUTH_URL` as in `docs/tests/e2e-cards.md`, then `pnpm dev`.

1. `/?offline&autoplay&body=portus&tier=medium&shadercheck` — the spawn view: keep on the north axis
   behind Juno, castle street framed by houses, gatehouses east and west, portal courts round the
   three portals (rings inside the arches), market stalls round Juno. Compare with
   `docs/reviews/2026-10-12-portus-village-packed-plaza.jpg` and `/tmp/fl-village-src/plaza_eye.png`.
   Console: `[shaders] post-warm-up window closed: 0 new builds`. F3: draws (town adds 4), tris.
2. Same URL + `&webgl`: identical look (texture arrays on WebGL2), 0 builds.
3. `/?offline&autoplay&body=portus&tier=low&shadercheck` and `+&webgl`: roof shells and tree cards,
   flat (no normal maps), no town shadows; still reads as the same town.
4. `/?bench=g1` (Medium, compare p50 with F10's 59.9 fps and draws ~290) and
   `/?bench=g1&tier=low&cpuslow=4` (F11, ≥ 30 fps). A/B: add `&notown` (hides the town's meshes; its
   colliders stay).
5. Walk (WASD, offline is fine): spawn → castle street → castle gate → ward (hop the keep steps);
   east street through the gatehouse out to the signpost and back; west street the same; run into a
   house front and a tower (stopped, slides along); dodge-roll into a wall (no tunnelling).
6. Juno: walk up and press E (trade opens within 3 m). Dummies: inside the fenced yard, open toward
   the spawn; hit all three. Hall of Firsts plaque: stands in front of the hall's steps, readable.
   Portals: walk into each court; travel works; come back to Portus (warm-up again, 0 builds).
7. Online (server + client from this branch): walk the streets and gates — no corrections; push into
   a house — no rubber-banding (client and server agree).
8. Night `&time=0.95`: windows glow warm, braziers and lamps glow, nothing blooms hard by day.
9. Grass: none on the plaza, streets, ward or portal floors, none poking through buildings; it grows
   in the gardens, gaps and the meadow outside the walls. Blossom trees and rocks stay outside the
   walls and off the gate roads.
10. Outside: from the east road at ~70 m look back at the gatehouse (the design's `gate_eye.png`); the
    road paving follows the rim at its end without z-fighting; from far round the planet the keep
    tops the horizon (LOD1) and the town disappears below it.
11. Failure path: DevTools → block `/assets-dev/portus/portus.glb` → reload: stone boxes stand where
    the colliders are and still block; console warns once.
12. `?stage=1` (admin, online): the crowd ring stands on the plaza, nobody stuck in a stall.

## Final run

(filled in below after the full `pnpm test`.)

# Pad platforms and pad-0 outposts in the game — lane/pad-outposts (Opus 5.5)

Brief: `/tmp/fl-pad-outposts-brief.md` and the coordinator's Phase B decisions. Phase A designed the
outposts in Blender (renders, layouts and notes in `/tmp/fl-design-pads/`, copies of the arrival
views and plans in `/tmp/fl-go/shots/pad-outposts/`); Phase B puts them in the game. Branch
`lane/pad-outposts`, main merged in twice (the zones, creeps, combat, save, home, map and SFX lanes,
then the combat and save follow-ups). Pushed to the lane branch only; nothing merged into main or
deployed. No browser was driven (Codex does the checks); the check list is at the end.

## What was built

| Layer | Files | What it does |
|---|---|---|
| Asset pipeline | `tools/blender/pads/` (`build.sh`, `design.py`, `pack.py`, `gen_outposts.py`, `site_data.mjs`, `extract_kit.py`) | Checks the three kit archives' SHA-256, extracts data only, exports the game's own ground, breakables, props, portal and guide (`site_data.mjs`), builds and validates each layout headless (0 problems required), packs one GLB per planet with the Portus packer, meshopt, generates the shared data and manifests, checks ≤ 2 MB per planet. Rebuilds byte-identical GLBs. |
| Shipped assets | `apps/client/public/assets-dev/outposts/{arcadia,hollowmere,meridian}/` | GLB + manifest each, Meridian's two WebP strips; Arcadia and Hollowmere point at the Portus strips (`../../portus/…`). |
| Shared data and code | `content/padOutposts.ts` (generated), `planet/sites.ts`, `planet/townFrame.ts`, `planet/siteGround.ts`, `planet/townGround.ts`, `planet/outpostGround.ts`, `planet/town.ts`, `planet/props.ts`, `net/protocol.ts` | One structure-site system for Portus and the planets: placements (pad-0 layout; a waystone at one fixed offset from every other pad's platform), solids (ground-touching ones reach 1.5 m below their base), `StructureCollider` (resolve, raycast, blocks, footing, clearSpot, isClear, crosses, near) for every body; ground masks for grass and natural props; `PROPS_VERSION` 5, `PROTOCOL_VERSION` 4. |
| Server | `world/BodyRoom.ts`, `world/destruction.ts`, `world/npc/{steer,brain,attacks,NpcSystem,npc,spawns}.ts` | The zones lane's wall seams (`walls`, `wallBetween`, NPC sight/strikes/bolts) now serve every site; fuel-drum blasts too. NPCs: structure checks with their own body, obstacle following near structures, spawns/summons/leaps/pulls clear of buildings, walled-off or wedged chases evade after 5 s, wander and return walks can't hang on a wall, spawn groups start beside the outpost. |
| Client | `render/townAssets.ts`, `render/townMaterial.ts`, `world/SiteTown.ts` (was `PortusTown.ts`), `world/outpostPaths.ts`, `world/siteGrass.ts`, `world/Planet.ts`, `world/Portals.ts`, `world/palette.ts`, `world/terrain.worker.ts`, `game/Game.ts`, `game/CombatClient.ts`, `ui/mapRaster.ts`, `world/mapAtlas.worker.ts` | One loader for every site (shared strips decoded once per session); the town renderer generalised (one cell, LOD, depth-only shadow copy, fallback); path decals; the other pads' platform + waystone as one instanced mesh per material; glow slot mode and albedo floor; grass masks; old pad discs and the portal base hide when the outpost is drawn; the Patchkit's ally pick stops at walls; the map and minimap draw outpost plans. |
| Docs | `docs/DECISIONS.md` D42–D46, `docs/ASSETS.md` ("Pad outposts", SciFi MegaKit registered), this file | |

## Decisions (full text in DECISIONS.md)

- **D42** outposts, platforms and waystones as shared structure sites; rendering, look, grass, props, map, creep groups beside the outpost.
- **D43** structures stop combat like the Portus town's (one implementation); solids reach 1.5 m under their base.
- **D44** NPCs steer round buildings (obstacle following near structures), never stuck: walled off or wedged for 5 s → evade; the jetty stays and melee-only NPCs evade its end.
- **D45** no perches (validator + shared test).
- **D46** `PROTOCOL_VERSION` 3 → 4, client first, server right after (as D40).

The coordinator's seven Phase B answers are in: Hollowmere keeps its palette with glowing teal lamps
and windows and a 0.045 albedo floor; Meridian's deck is 82 % albedo with its stripes; steer-around
plus the 5 s evade, tested round the barn and the hangar; only structures shelter from blasts
(breakables unchanged); jetty and boardwalk kept, jetty-end test; the chapel stays 1.96 m off the
fence; waystones on all 41 other pads in one instanced draw (platform + waystone share it).

Not shipped: the Kenney Castle Kit 2.0 archive (CC0, `License.txt` checked, SHA-256
`921f3f73927bb23106cae34bc21d5ab4b033a9fc120475e96f714a406e3169df`): its flat colour-map look clashed
with the Quaternius kits, so nothing from it was used or registered.

## Numbers

Download per planet (own files; the Portus strips, 423 KB, are already cached from Portus):
Arcadia 624,073 bytes, Hollowmere 237,541, Meridian 467,236.

Draws and triangles the outpost adds at the pad-0 arrival views (`world/outpostTown.test.ts`, four
views from the pad; the outposts are inside one LOD distance, so Medium, High and Ultra match):

| Planet | Medium / High / Ultra | Low |
|---|---|---|
| Arcadia | 2 draws, 26.5k tris; shadow map 2 draws, 20.2k | 2 draws, 16.9k |
| Hollowmere | 2 draws, 12.5k; shadow 2 draws, 10.9k | 2 draws, 12.5k |
| Meridian | 1 draw, 16.4k; shadow 1 draw, 15.0k | 1 draw, 16.4k |

The plain pad disc and the portal base they replace were 2 draws. The other pads' platform +
waystone: 1 draw per material (1 on Meridian, 1–2 elsewhere) and only where a pad is within 450 m,
which no other pad is at pad 0.

## Tests

New: `packages/shared/src/planet/sites.test.ts` (frames, placements, waystone offset, bases, gaps to
breakables, clear spawn/guide/portal walks, no perches, lanes, rays), `outpostGround.test.ts`;
`apps/server/test/outposts.test.ts` (real path: walk into the barn, the jetty walk, a save in the
hangar, a teleport into the chapel, a carbine shot through the barn vs beside it; NPC sight, bolts and
blasts at walls; 12 chases round the barn and hangar; the jetty end; spawn groups beside the
outpost; a big NPC put down clear); `apps/client/src/world/outpostTown.test.ts` (one cell, two
materials, glow slots, paths on the ground, the instanced pads where the colliders are, budgets per
tier, fallback); outpost cases in `render/townAssets.test.ts`, `render/shaders.test.ts` (glow and
albedo floor, plain and instanced, both backends), `ui/mapRaster.test.ts`, `world/palette.test.ts`.
Changed: `apps/server/test/combat.test.ts` and `movement.test.ts` stand their players east-north-east
of Dawnpad (due north is the barn now).

Runs (machine shared with other lanes, load average 10–76):

- `pnpm typecheck` (shared, server, client): clean after both merges.
- `pnpm test` once at the end: 1,506 of 1,551 passed, 168 files. The failures: 34 in six server
  files that teleport players 40–55 m due north of Dawnpad, into the outpost's barn, so the server
  put them down a few metres off and the tests' arrival checks timed out (`quest-helpers.offPad`,
  `support`, `rollback`, `lifecycle` helpers now stand them east-north-east within 80 m of pad 0;
  rerun: 71/71 and 30/30); 8 client UI files that couldn't start (main added `happy-dom`; after
  `pnpm install` 35 files, 184/184); and load timeouts that pass alone (shader props, grass,
  fracture, two quest cases).
- Then the whole server project again: 815 of 824; the 9 (egg persistence, moderation, stage
  admin: timing under load, none near an outpost) pass alone, 40/40.
- Targeted along the way: outposts, zones, town walls, NPC unit/perch/review/spawns (100/100),
  combat, destruction, prop cover, movement, footing, stormcoil, support unit, town, prop climb,
  dodge ledge; client outpost view (15/15), town assets (19/19), shaders (both backends), palette,
  map raster, Portus town view.
- CodeRabbit (`coderabbit review --agent --base main`): one minor finding, fixed (the Blender site
  data no longer writes a null sun when the looks can't be read).

## Deploy order (D46)

`PROTOCOL_VERSION` 4. Client (Vercel, with `assets-dev/outposts`) first, the server right after in the
same batch. Old client on the new server: invisible walls within ~12–45 m of each pad 0 (crossing
refusals, rubber-banding) and shots stopping in mid-air; new client on the old server: stopped by
walls the server doesn't know (stricter, no corrections), NPCs walking through buildings. With the
bump, stale tabs get 409 on their next join and reload once.

## Unverified

- The look in a browser: the game's material (slot tints, constant roughness, glow luminance 1.6,
  Hollowmere's albedo floor) against the Blender renders; the path decals' texture scale; whether
  the glow reads as lamps by day without blooming too hard.
- Frame rate on real hardware (only draw and triangle counts are measured) and the shader warm-up
  on arrival (0 post-warm-up builds expected: one more material pair on Hollowmere).
- Online feel at the outposts: NPC creeps rounding buildings with real players, the jetty walk with
  the real controller (the server accepts the scripted walk).

## Browser check list (for Codex)

Your own stack on your own ports (`PORT`, `CLIENT_PORT`, `API_PROXY_TARGET`, `VITE_API_URL`,
`CLIENT_ORIGIN`, `BETTER_AUTH_URL` as in `docs/tests/e2e-cards.md`), headless with `--mute-audio`.

1. `/?offline&autoplay&body=arcadia&tier=medium&shadercheck`: the arrival view north: the dawn
   gate frames the portal, the barn across the pond, the windmill on the rise right, Lark's cottage,
   the well, the fisher's hut and jetty left. Compare `/tmp/fl-go/shots/pad-outposts/arcadia_arrival.png`.
   Console: `[shaders] post-warm-up window closed: 0 new builds`. No plain grey pad disc under the
   platform, no cylinder under the gate. Overlay (`` ` ``): the outpost adds 2 draws.
2. Same for `body=hollowmere` (violet dusk, chapel behind the bell gate, teal lanterns and lit
   lancets glowing, nothing pitch black) and `body=meridian` (scanner gate, relay mast, office,
   billboard, condenser, hangar; white pylons with teal heads; no kit logo anywhere).
3. Each of the three with `&webgl`: identical look, 0 builds. With `&tier=low`: roof shells and tree
   cards, flat shading, no outpost shadows.
4. Night `&time=0.95` on each: lamps and windows glow and bloom softly; by day (`&time=0.4`) they
   glow without washing out the walls.
5. Paths: walk each outpost's paths (offline is fine): stone or brick ribbons on the ground, no grass
   through them, no terrain poking through, no z-fighting where two meet (Meridian's mast path on the
   slope north). Grass grows beside paths and buildings, none on the pad apron.
6. Walk into the barn, the chapel, the hangar and the cottage: stopped, slide along; walk out on the
   Arcadia jetty and Hollowmere boardwalk to the end; no roof is reachable by jumping.
7. Online, admin: fast-travel (or teleport) to another pad: its platform and the waystone 9.6 m south
   of it stand on the ground, upright, and block; no plain disc under the platform.
8. Online: fight a creep group near pad 0 (Hollowmere bonewalkers, Meridian associates) round a
   building: they come round it or give up and run home within ~5 s; none walks into a wall or stands
   at one. Shots and grenades stop at walls.
9. Map (M) and minimap on each planet: the outpost's plan (paving, roofs, trees) round pad 0.
10. Failure path: block `/assets-dev/outposts/arcadia/arcadia.glb` and reload with `body=arcadia`:
    stone boxes where the colliders are (waystones included), the old pad discs back, a console warning.

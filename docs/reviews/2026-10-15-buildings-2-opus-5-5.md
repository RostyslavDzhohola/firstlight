# Round 2 buildings — lane/buildings-2 (Opus 5.5)

Brief: the coordinator's round-2 message (`/tmp/fl-go/round2.md`, the owner's picks of 2026-10-15).
Branch `lane/buildings-2` from `origin/main`, main merged in once (the shops lane). Pushed to the
lane branch only; nothing merged into main or deployed. No browser was driven (Codex does the
checks); the check list is at the end. Renders for the owner: `/tmp/fl-go/shots/buildings-2/`.

## What was built

| Item | Where | What it does |
|---|---|---|
| Round-2 pieces | `tools/blender/round2/` (`opus/` sources, `astra/` GLBs SHA-pinned, `convert.py`, `pieces.py`, `preview.py`) | The Opus house, gate A and Waystation Nine and Astra's gate B and stilt shelter, each as one vertex-colour mesh on five `OK_*` slots with AO, grime and noise baked in (D-b2-5). |
| Portus market houses | `tools/blender/portus/build.py`, `pack.py`; `assets-dev/portus/`; `content/portusTown.ts` | The Opus house A on the four house plots (sized to each plot, variants coral/slate/moss/plum), same colliders and layout; explicit LOD1 without the small parts. |
| Portal gates (D-b2-2) | Portus courts (`build.py`, `pack.py`), `pads/design.py`, `world/Portals.ts` | Gate A in Portus' three courts (dais, obelisks off the dais) and on Meridian's pad; gate B (×1.49) on Arcadia and Hollowmere. The game draws a swirling arched membrane (TSL) in gate A's opening, the ring stays for gate B. |
| Walled outposts (D-b2-1) | `pads/design.py` (`wall_ring`, `build_walls`), `pack.py`, `gen_outposts.py`; `content/padOutposts.ts` `wall`; `planet/zones.ts`; `BodyRoom.safeNow`; `npc/spawns.ts`; `Portals.ts`; `ui/zoneLabel.ts`; `debug/e2eHook.ts`, `e2e/player.ts` | A wall ring round pad 0 with three gates (Arcadia 32 m, Hollowmere 42 m, Meridian 48 m); inside is safe at once; gate border strips; NPC groups start outside; compass to the nearest gate; "Dawnpad outpost" label; e2e leaves through a gate. |
| Waystation Nine, stilt shelter (D-b2-4) | `pads/design.py` | Meridian's courier depot → Waystation Nine on the flattest ground west of the pad; Hollowmere's ferry shed → the stilt shelter. |
| Shop stalls (D-b2-3) | `pads/design.py` (`build_shop`, `place_shop`), `padOutposts.ts` `shop`, `content/shops.ts` | A stall inside every outpost's walls facing the pad; `SHOP_SPOTS` are the keepers' places behind the counters. Portus keeps Juno's stall. |
| Protocol | `net/protocol.ts` | `PROTOCOL_VERSION` 5; `PROPS_VERSION` 6. |

## Numbers

Shipped bytes (≤ 6 MB Portus, ≤ 2 MB per planet): Portus 2,272,812 (was 2,797,910 in ASSETS; the
round-1 build had 2,369,240 for the GLB alone); Arcadia 678,795 own files, Hollowmere 360,396,
Meridian 495,048.

LOD0 triangles as laid out: Portus 186,890 (houses 4,710–5,010 each, LOD1 3,664–3,964; gates 3,304);
Arcadia 30,014, Hollowmere 21,731, Meridian 21,663.

Draws and triangles at the arrival views (tests `world/portusTown.test.ts`, `world/outpostTown.test.ts`):

| Site | Medium / High / Ultra | Low (≤ 25k on the planets) |
|---|---|---|
| Portus spawn views | 2 draws, 190.8k; shadow 2 draws, 157.5k | 2 draws, 141.0k |
| Arcadia | 2 draws, 32.3k; shadow 2 draws, 25.0k | 2 draws, 22.7k |
| Hollowmere | 2 draws, 24.6k; shadow 2 draws, 21.3k | 2 draws, 24.6k |
| Meridian | 1 draw, 24.6k; shadow 1 draw, 21.6k | 1 draw, 24.6k |

Low on Hollowmere and Meridian is close to the 25k cap: the wall posts lost their lanterns and
Meridian's wall its mid glow strip (the cap tops glow instead) to get there. The gate A membrane is
one more transparent mesh per portal (Portus 3, Meridian 1).

Shop keepers (`SHOP_SPOTS`, world metres): Arcadia `[271.0583, 420.186, -17.8155]` (site −9.7 E,
−17.8 N), Hollowmere `[395.6749, 638.2762, -19.3793]` (−1.0, −19.4), Meridian
`[368.7293, 930.8119, 6.6748]` (−12.3, 6.7). Juno unchanged.

## Tests

- New/changed shared: `planet/zones.test.ts` (outpost zones on all three planets: safe at once
  inside, wild outside, gates for the compass, portal/shop inside), `planet/sites.test.ts` (ring
  pieces' foundations, perches inside the walls allowed, Waystation Nine stops rays, the gate's
  apron exemption), `content/shops.test.ts` (walk up to the counter's front), `props.test.ts`.
- Client: `ui/zoneLabel.test.ts`; the outpost and Portus budget tests pass unchanged.
- Server: `npc-spawns.test.ts` (every group starts outside the walls; arrival herds within 20 m of
  the wall, packs within 32 m), `outposts.test.ts` (Waystation save, enforcer round the barn, the
  haystack case), `zones.test.ts` (weapons outside through the south gate), fights moved outside
  the walls in `starter-weapons`, `hunt-pointer`, `rules`, `movement`, `shops`; pad-ring rules at
  pad 1 in `evade-reset`, `npc-review`; the horse rides in through Arcadia's south gate.
- `pnpm typecheck` clean. Full `pnpm test` after the merge of main: 1,674 of 1,674 passed, 187
  files (the first full run, before the test moves above, had 27 failures in 7 server files: fights
  15–30 m off pad 0, now inside the walls).
- CodeRabbit (`coderabbit review --agent --base main`): one minor finding, fixed and it mattered: the
  Astra palette lookup scanned every material in the scene, so inside the pads design build (kit
  textures loaded) gate B and the shelter sampled a kit texture; it now reads only the imported
  GLB's own materials. The outposts were rebuilt (Arcadia's gate is pale stone again, the shelter
  violet), shipped files and ASSETS hashes updated, outpost tests 150/150.

## Deploy order

`PROTOCOL_VERSION` 5 (shared with the other round-2 lanes). Client (with `assets-dev/portus` and
`assets-dev/outposts`) first, server right after. Old client on the new server: invisible walls round
pad 0 and a wider protected zone than it draws; new client on the old server: walls the server
doesn't know and creeps spawning inside the walls. Stale tabs get 409 and reload.

## Unverified

- The look in the browser: vertex colours through the town material (renders are Blender's), the
  membrane's swirl and bloom, the walls' textures, Astra's gate B scaled ×1.49.
- Warm-up: 0 builds expected (the membrane is one new material, in the scene from the start; the
  `OK_*` slots are the same town material).
- The e2e journeys J2/J3 with the walls (code updated so leaving a walled outpost goes through the
  nearest gate; J3.1–3.3 "a hostile in view within 20 s" now needs a walk out to the creeps beyond
  the walls).
- Pad 0's cover breakables now stand inside a zone where nobody fires (they stay pinned, unbroken).

## Browser check list (for Codex)

Own stack, own ports (`docs/tests/e2e-cards.md`), headless with `--mute-audio`.

1. `/?offline&autoplay&body=portus&tier=medium&shadercheck`: the plaza: Opus houses (teal shop
   fronts, string lights, coral/slate/moss/plum roofs) on the four plots; the three portal courts are
   gate A (floating arch, destination globe, obelisks), each opening filled by a slow swirl in the
   destination's colour, no ring. Console: 0 post-warm-up builds. Compare `portus_plaza_eye.png`,
   `portus_street_eye.png`.
2. Walk into each Portus portal from the plaza (up the dais' two steps): travel works, no corrections.
3. `body=arcadia`: gate B (pale stone arch) round the ring; the wall's east half and its three
   gates; the barn, windmill and haystacks outside the north gate; the shop stall south-west of the
   pad. No green ring round pad 0; the border strips across the three gate passages. Zone label
   "Dawnpad outpost" inside, danger outside a gate; the compass points at the nearest gate.
4. `body=hollowmere`: gate B, the stilt shelter by the pond (was the ferry shed), the wall ring with
   lanterns on the gates, the stall south of the pad. `body=meridian`: gate A with the membrane on the
   pad edge, Waystation Nine west of the pad, the stall in front of it, the wall with glowing cap
   tops, the lake side open.
5. Each with `&webgl` and `&tier=low`; night `&time=0.95` (glow slots, windows).
6. Camera: back the camera into a wall and the Waystation drum: it stops short, no clipping.
7. Online: run out of each outpost through a gate (label flips at the strip), fight a creep outside,
   run back in while tagged: protected at once; buy at the stall right away.
8. Map and minimap: the walls and gates show in each outpost's plan.

# Round 2 buildings — lane/buildings-2 (Opus 5.5)

Brief: the coordinator's round-2 message (`/tmp/fl-go/round2.md`, the owner's picks of 2026-10-15).
Branch `lane/buildings-2` from `origin/main`, main merged in twice (the shops lane, then chars-3d). Pushed to the
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

Shipped bytes (≤ 6 MB Portus, ≤ 2 MB per planet): Portus 2,292,008 (was 2,797,910 in ASSETS; the
round-1 build had 2,369,240 for the GLB alone); Arcadia 680,907 own files, Hollowmere 362,500,
Meridian 495,616.

LOD0 triangles as laid out: Portus 186,890 (houses 4,710–5,010 each, LOD1 3,664–3,964; gates 3,304);
Arcadia 30,322, Hollowmere 21,871, Meridian 21,333.

Draws and triangles at the arrival views (tests `world/portusTown.test.ts`, `world/outpostTown.test.ts`):

| Site | Medium / High / Ultra | Low (≤ 25k on the planets) |
|---|---|---|
| Portus spawn views | 2 draws, 190.8k; shadow 2 draws, 157.5k | 2 draws, 141.0k |
| Arcadia | 2 draws, 32.6k; shadow 2 draws, 25.3k | 2 draws, 23.0k |
| Hollowmere | 2 draws, 24.7k; shadow 2 draws, 21.4k | 2 draws, 24.7k |
| Meridian | 1 draw, 24.3k; shadow 1 draw, 21.2k | 1 draw, 24.3k |

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
- `pnpm typecheck` clean. Full `pnpm test` after the shops merge: 1,674 of 1,674 passed, 187 files;
  after the chars-3d merge: 1,698 of 1,699, the one a new Ember Seal case at pad 0's ring, moved to
  pad 1 (8/8); after the Codex and browser-check fixes: 1,704 of 1,706, the two (an egg-medal retry
  and a falling-crate case, both load timeouts) pass alone (54/54) (the first full run, before the test moves above, had 27 failures in 7 server files: fights
  15–30 m off pad 0, now inside the walls).
- CodeRabbit (`coderabbit review --agent --base main`): one minor finding, fixed and it mattered: the
  Astra palette lookup scanned every material in the scene, so inside the pads design build (kit
  textures loaded) gate B and the shelter sampled a kit texture; it now reads only the imported
  GLB's own materials. The outposts were rebuilt (Arcadia's gate is pale stone again, the shelter
  violet), shipped files and ASSETS hashes updated, outpost tests 150/150.

## Codex review round 1 (gpt-6.1-sol, approve after fixes)

- **Should-fix, fixed: the rings were open over water and shallows.** Segments over water were
  dropped, so Meridian's shallows at 49–62° (≤ 0.1 m deep) were walked across with no corrections,
  and back in while tagged. Now every stretch of the ring over water or shallows is a sea wall from
  the lake bed (`{b}_ringsea`: top 2.4 m over the water or the shore, 5 m deep; the rings' water is
  at most 3.4 m deep), and every ring piece stands on the highest ground under it, never under the
  water. New test (`sites.test.ts`): at every quarter degree round each ring, feet walking, wading
  or swimming (SWIM_FLOAT under the surface) cross only in a gate's opening; without the sea walls
  it finds 738 / 295 / 347 open crossings on Arcadia / Hollowmere / Meridian.
- **Should-fix, fixed: gate border strips floated or sank** (a flat box at the centre's ground:
  −1.32 to +1.54 m on Meridian's 250° gate). Now `world/gateStrips.ts` drapes each strip on the
  terrain like the path decals (a row every 0.25 m, lift over the highest path decal plus the
  terrain's crease). Test (`gateStrips.test.ts`): all nine passages, every vertex, edge midpoint and
  triangle centre within the lift band over the ground, facing up, centred on its gate.
- **Should-fix, fixed: the haystack case didn't guard the blocked-strike rule.** A slim post outside
  the walls now: a signpost by Arcadia's south gate path (`a_signpost`), and the case with a
  Bonewalker 2 m from its target, in melee reach, the post on the strike's line. With the
  blocked-strike handling switched off it fails (the Bonewalker stands swinging at the post, 0 m
  moved); with it, it goes round or gives up in time. The haystack case stays.

Budgets after the fixes: Low 23.0k / 24.7k / 24.3k (cap 25k); Meridian's land walls are one box
with a glowing top, posts only where a land wall meets another piece.

## Browser check round 1 (Codex, `/tmp/fl-go/buildings2-check/report.md`)

Passed: J2/J3 12/12, 0 post-warm-up shader builds and ~60 fps on every planet, tier and backend,
the shops open with E on all three planets, Safe → Danger at every gate. Two defects, fixed:

- **Walking into a Portus portal stopped at the dais** (5.3 m out; only a jump got players up). The
  shared collider pushes feet off a solid's edge unless the body's centre is already over it, so
  the 0.21/0.41 m dais steps acted as a curb. Gate A's dais is now a 0.06/0.14 m threshold with no
  collider (Portus and the Meridian gate rebuilt; the membrane's base follows). Test
  (`game/PlayerController.test.ts`): the real controller walks from 9 m out into each Portus portal
  with W alone; it stopped at 5.28 m before the fix.
- **The camera went into a wall the player was pressed against** (lens 0.2 m inside: the camera
  never came closer than 0.6 m to the head). Now it stops short of the wall by 0.3 m, or by half
  the way when the wall is closer than 0.6 m. Test: pressed against a Portus house and turned away,
  the lens stays ≥ 0.15 m short of the wall (−0.18 m with the old rule).

## Combined with lane/solid-props (natural solids, D-solid-1)

`origin/lane/solid-props` (4b1bda9) merged in: conflicts in `BodyRoom.ts` (both `inWalledZone` and
`natureSolids`), `PlayerController.ts` (the natural solids' camera ray with the new close-wall
reach), `horses.test.ts`, `outposts.test.ts` (header), `protocol.ts` (one comment for both: 5 stays);
`PROPS_VERSION` stays 6. Added: `openSpotOutside` keeps natural solids off its line (room for a big
creature); a test over all three outposts that no trunk, boulder or rock stands in a gate's passage,
beside the rings (land and sea walls), on a path, at a shop's counter or on the walk into the
portal; and the real controller, wired as the game wires it, walking and swimming into the rings
(land walls, a wading sea wall at Hollowmere, swimming at Arcadia's and Meridian's lakes): no frame
ends inside a wall or across it (the solid-props lane's final clearance pass covers the walls).

Runs on the combined branch (46d597a): `pnpm typecheck` clean; `pnpm test` 1,751 of 1,751, 197
files; J2/J3/J5 on the WebGL project by Codex gpt-6.1-sol: 16 of 16 (`/tmp/fl-go/buildings2-e2e/report.md`).
Codex notes J3's "creep in view" checks size on screen, not occlusion: from inside the walls the
creeps beyond them may be hidden by the wall (J3.1's Arcadia shot ends with the player in the lake
against the inside of the sea wall).

## Codex review of the combined branch (f2ab8ba, approve after fixes; `/tmp/fl-f2ab8ba-review/report.md`)

- **Should-fix, fixed: swimmers passed through sea walls on the server.** The movement validator
  skipped the occupancy and crossing checks while swimming (60/60 steps through Arcadia's 280° and
  Meridian's 95° sea walls accepted). Every solid now stops a swimmer as it stops a walker; swimming
  only changes the ground rules. Real-path test on both sea walls (0 refusals without the fix).
  The check is the validator's general path, so jetties, boardwalks, town walls and natural solids
  over water are covered alike (the client controller already pushed swimmers out of all of them).
- **Should-fix, fixed: `pnpm typecheck` failed** (TS2339 in `sites.test.ts`: paths have no name).
  My earlier "clean" runs piped a silent typecheck through `tail` without checking its exit code;
  it exits 0 now.
- **Should-fix, fixed: the camera missed narrow spires.** The natural-solid camera ray kept solids
  ≥ 1.2 m wide; it now stops at every boulder and spire, never trunks (`CAMERA_SOLID_KINDS`).
  Regression from the reported Meridian spot (the lens sat 1.43 m inside a 1.12 m spire).

Runs (aaae215): typecheck exit 0; affected suites 375/375 (shared planet, client game, server
movement, outposts, solid props, wading, horses, trunks, zones); J2/J3/J5 on WebGL by Codex 16/16
(`/tmp/fl-go/buildings2-e2e-2/report.md`).

## Deploy order

`PROTOCOL_VERSION` 5 (shared with the other round-2 lanes; one deploy with lane/solid-props). Client (with
`assets-dev/portus` and `assets-dev/outposts`) first, server right after. Old client on the new server: invisible walls round
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

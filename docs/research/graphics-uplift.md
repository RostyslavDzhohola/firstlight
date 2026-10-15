# Graphics uplift: study the references, don't rebuild (HANDOFF 6g)

The owner loves the look of littleprince.dev and of a trailer posted on X ("especially the world …
the clouds and the grass … I don't want a major rebuild"). This note says what makes those images
look good, technique by technique; what three.js r186 (WebGPU + TSL) can do at our budgets; what
it costs; and a prioritised plan of small lanes. A working prototype of the top changes sits behind
`?meadow` (off by default) so the owner can see it in our own renderer.

## Summary for the owner

- **Keep three.js.** The reference is a Unity WebGPU build that downloads ~282 MB before the
  first planet is fully in and ran at 18–23 fps in our measurement on this M1. The prototype draws
  a dense meadow with flowers and clouds at Medium for about +2.7 ms of GPU time (target 12 ms),
  with no extra draw calls, and holds 60 fps. What makes the reference look
  good is art direction and assets, not the engine.
- **The world (grass, flowers, clouds, colour) can get most of the way there in about a week of
  small lanes, client only, no protocol change.** The prototype shows it: grass clumps instead of
  single blades, wildflowers in drifts, a drifting cloud layer, olive ground, and a filmic grade.
- **The characters look flat because of the assets, not the renderer.** They need sculpted heads and
  hair, normal and AO maps, painted textures and secondary motion (scarf, hair). That is the
  character lane (item 7) in Blender, on the existing rig.

Top recommendations, in order (before/after images in `/tmp/fl-go/gfx/`, open `index.html` there;
the headline pair is `01_before_after.jpg`):

1. Meadow grass with wildflower drifts.
2. Clouds in every sky, with cloud shadows next.
3. A filmic grade: ACES tone mapping, a gentle S-curve and olive greens instead of lime.
4. Ground and rocks: olive ground under the grass, moss on rock tops, then a small sculpted rock kit.
5. Characters with sculpted heads and hair, cloth normals and spring-bone secondary motion (item 7).

## 1. What we looked at

| Source | How | Notes |
|---|---|---|
| Trailer (X post by @Saccc_c) | Downloaded with the owner's yt-dlp into `/tmp/fl-ref-video/` (3840×2160, 60 fps, 63 s). Frames at 2 fps, 4K stills, 60 fps bursts and crops in `/tmp/fl-ref-frames/` | The same game as littleprince.dev (the same prince, planet and volcanoes). The first 20 s are the meadow above a sea of clouds; then interiors, a desert and a fox in tall grass |
| littleprince.dev | Headless, muted Chrome (Playwright, WebGPU). Screenshots of the landing page, the level select and the B-612 level while walking, in `/tmp/fl-go/gfx/littleprince/` | The console says "Unity WebGPU". Asset names give away the techniques (below) |
| Our client | Local Vite client offline (`?autoplay&offline`), Arcadia, Medium (and Low), `time=0.265`–`0.29` (morning sun), clear weather, headless Chrome WebGPU on this M1. Shots in `/tmp/fl-go/gfx/final/` and `/tmp/fl-go/gfx/ours/` | One dense-meadow spot (118k grass instances in view) for every A/B |

What littleprince.dev downloads (sizes as served, from the Playwright response log):

| Bundle | MB |
|---|---|
| B-612 scene bundle | 67.4 |
| Shared hi-res assets | 41.5 |
| B-612 hi-res bundles 0–4 | 32.6 + 21.6 + 23.7 + 20.5 + 5.4 |
| Engine data (`.data.br`) | 27.0 |
| Level audio | 9.7 |
| Engine code (`.wasm.br`) | 9.2 |
| Vegetation textures | 6.5 |
| Everything for the first planet | **≈ 282** (344 with the next planet prefetched) |

Asset names worth knowing: `sky_hdri_day_alpha`, `sky_hdri_day_cloudring`, `sky_hdri_dusk_alpha`
(the sky and the sea of clouds are pre-rendered images, not simulated clouds), `steam` (the
volcano smoke is a flipbook texture), `rendering_textures_vegetation` (grass and flowers are
textured cards), `littleprince_arp_basecolor` ("ARP" is Auto-Rig Pro, a Blender rigging add-on: the
character was made and rigged in Blender), `littleprince_scarf_fabric_normal` (a fabric normal map).

## 2. Technique by technique

Each row: what the reference does (from the frames), what r186 WebGPU/TSL can do at our budgets
(Medium ≈ 60 fps on an M1, Low ≥ 30 fps; SPEC §7), the rough cost, and what we have today.
GPU costs come from the A/B in §3 where measured; others are marked as estimates.

### 2.1 Grass density and blade shape

- **Reference.** Long, thin blades (about 30:1 length to width) that arc over under their own
  weight; heights vary 2–3× within a clump; clumps rather than an even scatter; a mix of lush
  green, yellow-green and straw; taller stems with seed heads; near-black roots and light, warm
  tips. Near the camera the ground between blades is almost never visible. littleprince.dev draws
  it with alpha-tested cards (many blades painted into one texture) at very high density
  (`/tmp/fl-go/gfx/littleprince/crops/grass.png`).
- **Ours today.** One tapered blade per instance (0.07 m wide, 0.25–0.6 m tall), two greens from
  root to tip, Lambert-lit with an up-facing normal. Medium has 80k blades within 40 m (about
  16 per m²), Low 25k within 25 m, High 200k within 60 m. Seen from the player it reads as stubble
  on a lawn; the ground colour does the work (`final/base_*.png`).
- **What r186 can do.** (a) Geometry clumps (the prototype): each instance becomes 5 curved blades
  near the camera and 3 straight ones farther out, same instance count and draws. (b) Alpha cards
  like Unity: fewer vertices, but alpha test (discard) turns off the hidden-surface removal that
  Apple's tile-based GPUs depend on, so geometry blades are the better bet on an M1. (c) Compute
  culling and LOD with indirect draws on WebGPU (SPEC already plans compute grass on High): worth it
  only at High/Ultra counts.
- **Cost.** Prototype at the dense spot: triangles 0.31 M → 0.72 M per frame, draws unchanged,
  GPU see §3.

### 2.2 Wildflowers and ferns

- **Reference.** Daisies (white petals, yellow centre), buttercups, lavender or lupin spikes and a
  few pink ones. They grow in **drifts**: dense patches of one species with sparse singles between,
  on stems that rise above the grass so they read against it. Bright yellow-green fern fronds
  cluster around rocks; reeds and seed-head grasses near water; a few butterflies.
- **Ours today.** Quaternius flower groups and one fern model scattered as props by the shared,
  deterministic prop placer; few, and changing their density touches `packages/shared`
  (`PROPS_VERSION`).
- **What r186 can do.** Flowers inside the grass system (the prototype): a stem and a 6-petal head
  per clump, switched on by a per-clump value computed on the CPU from drift noise. Client only, no
  shared-code or protocol change, no extra draw. Heads tilt halfway toward the camera so they read
  as flowers, not slivers.
- **Cost.** Included in the grass numbers (the head and stem are part of the clump mesh).

### 2.3 Wind

- **Reference.** Slow, coherent gusts that roll across the meadow; tall seed heads sway most;
  flowers bob; nothing jitters. The scarf and hair blow (see 2.12).
- **Ours today.** A gust noise and a per-blade flutter on grass; per-instance sway on trees.
- **What r186 can do.** The prototype adds travelling wind waves that bend the field, from a few
  sines. (Its first version, 7 blades of 3 segments everywhere with noise in the vertex shader, drew
  4.2 M triangles and ran at ~44 ms per frame; the near/far clump split and moving per-clump values
  to the CPU fixed that.) Next:
  grass that parts around players (one uniform per nearby avatar), and one shared wind field for
  grass, trees, particles and cloth.
- **Cost.** Near zero.

### 2.4 Sky and clouds

- **Reference.** A sea of cumulus below the horizon (B-612 floats above the clouds), thin cirrus
  high up, a big soft sun halo, pink and violet sunsets with back-lit cloud edges. littleprince.dev
  gets this from pre-rendered HDRI images with a separate cloud-ring layer.
- **Ours today.** An analytic gradient plus a single-scattering lookup table, a sun disc and halo,
  stars and the sky planets. **No clouds at all**; the weather's `cloud` value only dims and greys
  the sky.
- **What r186 can do.** (a) The prototype: a cumulus layer on a shell 320 m above the ground,
  ray-hit per sky pixel and sampled from our existing 256² noise texture (no download), fixed to
  the planet and drifting, lit by the sun with a second tap toward it (bright tops, grey-blue
  bellies, silver lining), fading into the horizon haze. (b) Cloud shadows on the ground: the same
  density sampled along the sun ray in the terrain and grass shaders (a few texture fetches); a big
  "the world is alive" win. (c) A painted or Blender-rendered cloud ring or HDRI per body (the
  Unity approach), ~0.5–1 MB each as KTX2. (d) Raymarched volumetric clouds: too heavy for Medium.
  (e) A cloud sea below the horizon for a "floating island" body: an art choice, cheap.
- **Cost.** Clouds: see §3 (only sky pixels pay). Cloud shadows: estimate 0.2–0.4 ms at Medium.

### 2.5 Light and grade

- **Reference.** A low, warm sun most of the time; strong back light (rim light on the character,
  glowing grass tips and petals); cool blue-violet shadows; heavy aerial perspective toward the sun;
  a filmic tone curve with soft highlights; saturated accents (the orange scarf, flowers) but olive
  and yellow-green foliage, never neon.
- **Ours today.** Neutral tone mapping, a per-body CDL grade, saturated palettes (film rule 1:
  "saturated around one key hue"), a fill hemisphere, sun 3.2–4.0 intensity. Greens come out lime.
  AgX already exists behind `?tonemap=agx`.
- **What r186 can do.** The prototype uses ACES filmic tone mapping, a gentle S-curve and +18 %
  saturation after the grade, and pulls the grass toward olive and straw. We tried all three of
  three's curves on the same frame (`/tmp/fl-go/gfx/04_grade.jpg`): AgX rolls highlights off most
  softly but washes the greens and the sky out; Neutral (today's) keeps the lime greens; ACES gives
  the deep blue sky and rich but natural greens closest to littleprince.dev. `?tonemap=` still
  overrides it. Next: per-body LUTs (`Lut3DNode`, SPEC §7.1
  already names it) authored in a photo editor; a golden-hour reference time for the landing,
  the character screen and staged scenes; grass tips that glow when you look toward the sun (in
  the prototype as an emissive term).
- **Cost.** Near zero (a few ALU ops per pixel).

### 2.6 Shadows

- **Reference.** Soft, long shadows from a low sun; contact shadows under feet, rocks and inside
  the grass; the character's shadow falls across the grass.
- **Ours today.** Medium: one 1024² map over a 40 m box (±20 m, PCF); High: 2048² over 80 m; cascades on
  High exist but are opt-in (`DEFAULT_OFF`); Low: blob shadows. Grass receives but doesn't cast.
- **What r186 can do.** Softer filtering (`PCFSoftShadowMap` or VSM) at Medium; turn cascades on
  by default on High after a visual check; screen-space contact shadows (`SSSNode`, new in r186) on
  High; fake grass self-shadowing by darkening the roots (in the prototype).
- **Cost.** Softer PCF ~0.2 ms (estimate); `SSSNode` ~0.5–1 ms (estimate, High only).

### 2.7 Ambient occlusion

- **Reference.** Strong occlusion at the base of the grass, under rocks, in cloth folds and between
  hair clumps, mostly baked into textures.
- **Ours today.** Baked vertex AO on terrain; GTAO on High/Ultra (WebGPU only).
- **What r186 can do.** Bake AO into every new Blender asset (free at runtime); grass root
  darkening (prototype); keep GTAO for High.
- **Cost.** Baked: none. GTAO at Medium would cost ~1–2 ms on an M1 (estimate): not worth it there.

### 2.8 Depth of field

- **Reference.** Only in cinematic shots (the king's dialogue, the fox in the grass). Gameplay on
  littleprince.dev is sharp.
- **Ours today.** `DepthOfFieldNode` in photo mode.
- **Recommendation.** Keep it for photo mode, staged scenes, the character screen and the landing
  page; not in gameplay (cost and readability).

### 2.9 Rock materials

- **Reference.** Rounded, chunky, sculpted boulders, half buried; a strong moss layer on top; dark
  baked crevices; a consistent warm grey-beige; ferns and grass growing around the base
  (`/tmp/fl-ref-frames/crops/rocks_stream_t7.jpg`, `ferns_rocks_t3.jpg`).
- **Ours today.** Quaternius low-poly rocks with a palette tint: flat, faceted.
- **What r186 can do.** Moss on up-facing rock (the prototype: a normal-vs-planet-up blend broken
  by noise); a small Blender-sculpted rock kit (5–8 rocks, 300–800 triangles each, baked normal and
  AO in one shared 1024² atlas); a grass and fern ring around each rock.
- **Cost.** Moss: near zero. Kit: a few hundred KB of KTX2; same draws.

### 2.10 The character: sculpt, face and hair

- **Reference.** Child proportions (a big head), a sculpted face with soft planes, small nose,
  painted blush and colour variation, eyelids and brows; eyes with iris, pupil and a catchlight;
  hair as large sculpted locks with deep crevices and a clear flow, not cards
  (`/tmp/fl-ref-frames/crops/faces_t22.jpg`, `/tmp/fl-go/gfx/littleprince/crops/face.png`).
- **Ours today.** A Quaternius base body with procedurally modelled outfits from a Blender script,
  90–110 KB per GLB, one 136 KB atlas, painted flat faces, a two-band toon ramp with a rim. The
  flatness comes from: no normal maps, flat colour areas, the two-band ramp flattening forms, no
  AO, no highlights, simple hair silhouettes.
- **What r186 can do.** Everything the reference does is plain asset work that three.js renders
  fine: normal, AO and roughness maps on a skinned mesh; a softer 3-band ramp or a lit material
  with a rim; morph targets for blinks and 3–4 expressions; eyes as separate glossy meshes.
- **Budget.** ≤ 20k triangles and two 1024² textures per starter (≈ 0.5–1 MB as KTX2), on the
  shared rig.

### 2.11 Cloth

- **Reference.** A fabric weave normal map on the scarf, a subtle pattern on the jacket, seams,
  buttons and a belt; sculpted folds at the elbows and knees.
- **What r186 can do.** Normal maps baked from sculpted folds plus a tiling fabric detail normal;
  `MeshPhysicalNodeMaterial` sheen for velvet or wool where we leave the toon look.
- **Cost.** Texture memory only.

### 2.12 Animation quality and secondary motion

- **Reference.** Hand-keyed, exaggerated animation: a bouncy run with wide arm swings and the head
  leading, anticipation and overshoot, idle breathing, the head turning toward things; the scarf
  flaps with every step (`/tmp/fl-ref-frames/burst/run_t6_tile.jpg`), hair jiggles; butterflies,
  pollen, smoke columns, water sparkles.
- **Ours today.** Quaternius Universal Animation Library clips with crossfades and a few authored
  emotes; light motes and weather particles; tree sway.
- **What r186 can do.** Spring-bone chains (a small verlet solver, 3–6 bones per scarf, ponytail,
  cape or ear) on the CPU for the nearest 16 avatars; head look-at; foot IK on slopes; leaning into
  turns; procedural breathing; stylised walk and run clips keyed in Blender on the same rig;
  butterflies as one instanced, vertex-animated draw; smoke columns as flipbook particles.
- **Cost.** CPU well under 0.5 ms for 16 avatars (estimate); butterflies one draw.

## 3. The prototype (`?meadow`)

Code: `apps/client/src/render/meadow.ts`, hooked into `grass.ts`, `atmosphere.ts`,
`terrainMaterial.ts`, `vegetationAssets.ts`, `post.ts` and `renderer.ts`. Without the flag nothing
changes. `?meadow=nograss,noclouds,noground,norocks,nograde` turns single pieces off.

- **Grass:** each existing grass instance becomes a clump. Cells nearer than 14 m draw 5 curved
  blades (2 segments) and a flower (22 triangles); farther cells draw 3 straight blades and a
  flower (8 triangles), from a second geometry that shares the instance buffers. Dryness, flower
  species and drifts are computed once per clump on the CPU when a cell is filled. Roots darken,
  tips glow toward the sun, travelling wind waves.
- **Clouds:** a planet-fixed cumulus shell (see 2.4).
- **Ground:** saturated green under grass pushed toward a darker olive.
- **Rocks:** moss on rock tops.
- **Grade:** ACES, S-curve, +18 % saturation.

GPU time per frame, Arcadia dense-meadow spot, Medium, 1785×1115 canvas (the owner's M1 window
size), WebGPU timestamp queries, median of 3 runs:

| Config | GPU ms per frame (median of 5 runs) | Run medians | Triangles | Draws |
|---|---|---|---|---|
| Medium today | 3.05 | 2.69–5.19 | 0.31 M | 144 |
| Medium + `?meadow` (everything) | 5.79 | 4.47–6.61 | 0.69 M | 144 |
| Medium + `?meadow=nograss` (clouds, grade, ground, moss) | 4.41 | 3.14–6.54 | 0.30 M | 143 |
| Medium + `?meadow=noclouds` (grass, grade, ground, moss) | 4.54 | 3.64–6.63 | 0.69 M | 144 |
| Low today (1125×703) | 1.77 | 1.62–2.12 | 0.13 M | 107 |
| Low + `?meadow` | 3.55 | 1.27–3.60 | 0.36 M | 107 |

Reading it: the whole prototype costs about **+2.7 ms of GPU at Medium** (the grass about 1.4 ms, the
clouds about 1.3 ms) and +1.8 ms at Low, with **no extra draw calls**. Medium's GPU target is 12 ms
and Low's 16 ms, so both stay well inside. Every screenshot run held the 60 fps vsync cap (frame
p50 16.6–16.8 ms) at Medium and at Low. The numbers are noisy: the frame rate is capped, so the M1's
GPU idles between frames and clocks down, which inflates and scatters per-frame GPU time; take them
as ±0.5–1 ms. Uncapped GPU timing wasn't available in headless Chrome (the timestamp query came back
empty), and an uncapped frame-time run was CPU-bound (6–7 ms per frame with and without the
prototype). The clouds are the obvious thing to trim: two density taps of three biplanar noise
samples (12 texture fetches) per sky pixel today; a 1-tap version for Low and a half-resolution sky
pass are the cheap fixes.

## 4. Prioritised plan (no rebuild)

Every lane is client only (no protocol bump, no server), small, behind a URL flag until the owner
approves the look, then on by default with the flag as a kill switch. Order = impact per day.

| # | Lane | Impact | Cost | Images |
|---|---|---|---|---|
| 1 | **Grade and light pass:** ACES by default, olive/straw grass and ground palettes per body, the S-curve, golden-hour reference times for the landing, character screen and staged scenes | High: the whole frame stops looking neon | ~0 GPU; ½ day plus owner review | `04_grade.jpg`, `final/prog_*.jpg` |
| 2 | **Meadow grass and flowers:** productionise the prototype; per-body sets (Arcadia daisies and buttercups, Hollowmere pale bluebells that glow at night, Meridian dry bunch grass and no flowers, Portus clover); Low uses only the lite clump; shader warm-up for the new material; grass parting around players | High: "the grass" the owner asked for | ~+1.4 ms GPU at Medium, 0 draws; 1–2 days | `02_grass_flowers.jpg` |
| 3 | **Clouds and cloud shadows:** per-body cover, height and colour; the weather drives cover (rain days overcast); night tint; Low gets a 1-tap version; cloud shadows on terrain and grass | High: every sky changes | ~+1.3 ms GPU at Medium (to trim), + ~0.3 ms shadows; 1 day | `03_clouds.jpg` |
| 4 | **Ground and rocks:** moss (done), a Blender-sculpted rock kit with baked maps, grass and fern rings around rocks | Medium | ~0 GPU, a few hundred KB; 1–2 days | `final/prog_d.jpg` (rock, panel 4) |
| 5 | **Characters (item 7):** sculpted heads and hair, painted textures, cloth normals, eyes, blink and expressions; keep the rig and clips | Highest for "the characters look flat" | ~0 GPU; 3–5 days in Blender with owner review | `05_characters.jpg` |
| 6 | **Motion and life:** spring bones (scarves, hair, capes), head look-at, foot IK, lean, breathing; butterflies; smoke columns | Medium-high | <0.5 ms CPU; 2–3 days | — |
| 7 | **Shadows polish:** softer PCF on Medium, cascades on by default on High after a check, `SSSNode` contact shadows on High | Medium | 0.2–1 ms on High; 1 day plus benches | — |

Not recommended: volumetric raymarched clouds, GTAO or DoF in Medium gameplay, alpha-card grass on
Apple GPUs, a renderer or engine switch.

## 5. Verdict: Unity WebGL vs three.js

Keep three.js. Unity would not buy us the look; it would cost the game.

- **The look is assets and art direction.** The reference's sky is a pre-rendered image, its grass
  is textured cards, its character was made and rigged in Blender. All of that renders in three.js;
  the prototype already gets the meadow, flowers, clouds and grade in our renderer.
- **Multiplayer.** Our server (Node, Colyseus, Better Auth, SQLite) shares deterministic TypeScript
  with the client: the terrain height function (client/server parity tests), the content
  catalogues, the protocol types. A Unity client would need a C# copy of all of it and a second
  network client, and the parity tests would no longer protect us.
- **Load size.** littleprince.dev streams ~282 MB for its first planet; its engine code and data
  alone are ~36 MB. Our client is ~0.6 MB of gzipped JS (production build) plus ~7 MB of models and
  textures (`assets-dev`: characters 1.6 MB, vegetation 2.3 MB, Portus 2.7 MB). A free browser game
  lives or dies by the seconds before the first frame.
- **Mobile.** Unity's web builds are heavy on memory and large wasm heaps; three.js runs on mobile
  Safari and Chrome with WebGPU or WebGL2 today.
- **Performance.** littleprince.dev ran at 18–23 fps (requestAnimationFrame rate) in the B-612
  level in headless Chrome on this M1 at 1600×900; the owner also calls it "a little bit laggy". In
  the same harness our Medium tier holds the 60 fps vsync cap, and the meadow prototype adds about
  2.7 ms of GPU time per frame with no extra draw calls.
- **What people do in three.js with Blender assets.** Bruno Simon's portfolio and his three.js
  Journey course (modelled, lit and baked in Blender, rendered in three.js); Abeto's *Messenger*
  (messenger.abeto.co: a stylised tiny-planet browser world; its 3D bundle is three.js r180,
  ~1.9 MB of JS); Dan Greenheck's grass and tree demos (named in SPEC §7.2 as our bar). The pipeline is the one we already have: Blender → glTF (meshopt) →
  KTX2 textures → TSL materials.

## 6. Reproducing

- Shots: Vite client with `?autoplay&offline&noprobe&body=arcadia&tier=medium&time=0.29&weather=clear`
  plus `&meadow` for the prototype; the camera is set through `window.__game.player`.
- GPU A/B: the game's `GpuTimer` is switched off for the run, then
  `renderer.resolveTimestampsAsync("render")` is read over 24 windows of 12 frames and divided by
  the frames rendered in each window.
- Scripts were kept outside the repo (`/tmp/fl-gfx-tools/`); the downloaded video and frames are
  untrusted data and stay in `/tmp`.

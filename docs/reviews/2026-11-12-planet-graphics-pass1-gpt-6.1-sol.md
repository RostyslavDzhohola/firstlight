# Planet graphics, pass 1 (lane/gfx-worlds) — review (Codex gpt-6.1-sol)

Scope: `62da084d..16a4e692` (meadow clumps, ground cover, terrain layers, water, clouds, far haze,
landmarks, the #46 fix). Source review, reasoning effort high, Standard tier; no tests run.

| # | Severity | Where (at `16a4e692`) | Finding |
|---|---|---|---|
| 1 | blocker | `apps/client/src/render/grass.ts:193–224`; `game/Game.ts:727–740` | A tier change clears every grass cell and picks the meadow material, but the live re-probe passes no world-update callback to the probe or the final warm-up, so no replacement grass mesh exists while warming: starting on Low and re-probing to Medium/High can first compile `grass-meadow` after play resumes (both backends), and the probe measures without the rebuilt grass. |
| 2 | should-fix | `render/water.ts:79–84` | The ripple tangent frame switches reference axes at `abs(up.y) = 0.95` while keeping the same sampled slopes: the perturbed normal jumps across two latitude circles (reflections, glitter, rain chop). |
| 3 | should-fix | `render/atmosphere.ts:201–204` | `?noaerial` only zeroes `aerialAmt`; the fog graph still computes luminance, the aerial colour, the distance transition and the mix on every fogged material. |
| 4 | should-fix | `render/landmarks.ts:360–397` | Landmark geometries stay in a module-level map and `dispose()` only detaches the group; neither the geometries nor the shared material has a teardown path (planet travel, renderer restart). |

Verdict: request changes. Decisions and fixes are recorded below this line as they land.

## Fixes (lane/gfx-worlds-fixes, Claude Fable 5.2)

All four accepted. Each test was run against the code before its fix and failed there (finding 3: the
only fog graph before the fix is the one the test finds both aerial uniforms in).

| # | Fix | Commit | Test |
|---|---|---|---|
| 1 | The probe takes the world: it streams before every frame and, after each tier switch, waits (bounded) for the grass that tier sizes before warming and measuring it; `reprobe()` (`render/probe.ts`) is the whole live sequence and `Game.reprobe` hands it the world and the warm-up hooks. The grass keeps a hidden, empty cell of the tier's grass (same material, attribute layout and shadow flag) that only the warm-up draws, so coverage never depends on grass near the camera. A graphics change tops the grass up before its warm-up too. | `130971ed` | `render/reprobe.test.ts` (Low → Medium and Low → Ultra on real grass over a renderer that keeps builds as three does: every warm-up and measurement frame draws the tier's grass, 60 frames of play after it build nothing by the shader monitor's count; the same on ground with no grass near); `render/grass.test.ts` "grass warm-up sample" |
| 2 | No tangent frame: each noise tap's R, G and A channels, centred and mixed by a rotation, are a vector in world space, and the surface takes the part in its own plane (`render/waterRipple.ts` on numbers, `render/water.ts` in TSL, same texture taps). The rain chop is that vector turned a quarter round the normal, scaled by the ridged channel about its real mean; the rain rings use cells in world space (their 2-D cell coordinates were zero everywhere on a planet-centred sphere). | `19a11447` | `render/water.test.ts` (the normal moves no faster than the surface across `abs(up.y) = 0.95` and every other latitude; the old frame, kept in the test, steps over 300 times faster there); `render/shaders.test.ts` "water: levels 0–3" (no branch on one component of a direction, WGSL and GLSL) |
| 3 | `fogNodeFor(settings.on)` (`render/atmosphere.ts`): one cached graph without the aerial tint and one with it, none with the fog off; `Planet.applySettings` selects it and the graphics change's warm-up compiles the selected one. `aerial` is in `PASS_FEATURES`. No tier switches the variant. | `f4bffc1f` | `render/shaders.test.ts` "fog: with the far haze off…" (the plain graph's shader reads neither aerial uniform and is shorter, WGSL and GLSL); `render/atmosphere.test.ts` "fog graph variants" |
| 4 | Landmark geometries are counted per body and the material across bodies: `dispose()` frees the mesh's render state, the body's geometry with its last user and the material with the last landmarks of any body; the next arrival builds both before its warm-up. Checked the second pass's additions for the same problem (fireflies, mist, shafts, foliage shading, the fog and sky graphs, the grass materials): nothing else holds per-body GPU data past its planet. | `8c9584f8` | `render/landmarks.test.ts` "landmark lifetime" (dispose-watch helper: leave and return, two bodies up at once, two planets of one body, the hub) |

Checked in the game with the shader monitor's count (`window.__shaders`, headless Chrome on the M1,
Arcadia, a walk after each step): Medium → Low, the re-probe from Low (to Medium), → High → Low →
Medium, the Aerial switch off and on, and a planet change (Arcadia ↔ Portus, Portus → Hollowmere) each
ended with 0 builds after the warm-up and the session's total unchanged in play, on WebGPU and on
WebGL2. The re-probe's own warm-ups compiled the tier's grass (11 + 2 builds) and its final warm-up
none. Not from these passes: an NPC's health bar (`world/npcs/bars.ts`, two unnamed basic materials
with no warm-up sample) still builds twice in the first fight of a session.

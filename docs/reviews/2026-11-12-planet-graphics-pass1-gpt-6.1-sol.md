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

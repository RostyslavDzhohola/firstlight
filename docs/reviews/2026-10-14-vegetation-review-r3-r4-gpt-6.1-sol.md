# Vegetation review, rounds 3–4, and the browser/GPU sign-off

Round 2 (48d0c20) approved the lane on code with browser/GPU sign-off pending. This record covers
what closed it. Raw evidence (JSON, console logs, screenshots) is in the builder's Codex output
folder `Documents/Codex/2026-10-12/vegetation-ab/round4`–`round6`, outside the repo.

## Method

Headless Chrome 154 (`--headless=new`, Metal ANGLE) driven over CDP, hardware WebGPU on an Apple
M1, Medium tier, 1360×765 canvas, rAF steady at 60.19 Hz. Main (6d69731) and the lane were served
by two Vite dev servers. Per body: MAIN, VEG, VEG, MAIN in fresh targets,
`?bench&autoplay&shadercheck&body=<b>&tier=medium&benchwarm=10&benchtime=30`; G1 once per branch.
An earlier attempt that fell back to SwiftShader (≈3 fps) was discarded. The Mac was in active use
throughout, so single p99 frames are noisy.

## Results (round 4, be9f46a)

Every run held a 59.88 fps median and logged zero shader builds after warm-up.

| Body | Frame p95 ms, MAIN → VEG (mean of 2) | Draws mean, MAIN → VEG | Triangles mean, MAIN → VEG | Warm-up, VEG − MAIN |
|---|---|---|---|---|
| Portus | 17.5 → 17.6 | 63.4 → 71.4 (+12.6 %) | 189k → 177k | +1.6 s |
| Arcadia | 17.5 → 17.5 | 119.8 → 126.6 (+5.7 %) | 216k → 198k | +1.1 s |
| Hollowmere | 17.5 → 17.4 | 142.8 → 153.6 (+7.6 %) | 244k → 223k | +2.0 s |
| Meridian | 17.5 → 17.5 | 116.7 → 117.8 (+0.9 %) | 137k → 133k | +0.9 s |
| G1 (40 avatars) | 17.6 → 17.5 | 293.8 → 293.0 | 1,035k → 1,022k | — |

Pad grass: none on the Arcadia, Hollowmere or Meridian pad discs (screenshots and an instance
readback of the blade roots).

## Round 3 (42bebf0): approved on code

be9f46a (near crowns 0.85 sky-facing, impostor foliage ×0.88) and 42bebf0 (impostor bark lit
with a horizontal toward-viewer normal) reviewed with no findings: view-space math including the
looking-down case, the shadow pass (r186 doesn't copy `normalNode`), WebGL2, and the merge of
main. Threshold screenshots: the trunk brightness step is smaller, front-lit card trunks aren't
too dark; crown shading and silhouette still change at the switch. A Hollowmere repeat
(16.7/17.5/17.7 ms VEG) didn't reproduce round 4's single 34.5 ms p99.

## Round 4 (adcedf0): approved, no findings

Medium draws full meshes to 30 m instead of 20 m. The camera sits ~6 m behind the player, so the
old switch landed ~14 m ahead. Props-only budget test, worst of 16 samples: draws 26 → 33,
triangles 58.6k → 99.4k (Hollowmere); the Medium cap goes 30 → 36. Nothing else is keyed to the
20 m value (shadow extent and warm-up are independent).

| Run, VEG | Frame p50/p95/p99 ms | Draws mean/max | Triangles mean |
|---|---|---|---|
| Hollowmere 20 m → 30 m | 16.7/17.5/34.5 → 16.7/17.2/31.0 | 153.5/187 → 156.5/188 | 223k → 230k |
| Arcadia 20 m → 30 m | 16.7/17.5/17.7 → 16.7/17.5/35.4 | 126.6/159 → 128.7/159 | 198k → 200k |
| Portus 20 m → 30 m | 16.7/17.6/27.3 → 16.7/17.6/36.7 | 71.3/84 → 73.1/87 | 177k → 178k |
| G1 20 m → 30 m | 16.7/17.5/19.9 → 16.7/17.5/17.7 | 293.0/397 → 296.9/413 | 1,022k → 1,023k |

Median and p95 hold; the p99 changes are single frames under concurrent load (main itself logged
a 36.0 ms p99 on Portus in round 4). Visual verdict: the card/mesh change is less noticeable at
normal play distance, an acceptable impostor compromise (static-image judgement).

## Open

- No dithered crossfade between mesh and card; the switch remains a visible but small change.
- G1 whole-scene draws (≈297 mean) were already above the Medium budget of 250 on main.
- WebGL2-fallback frame rate on hardware wasn't measured in this round.

Verdict: **merge approved, browser/GPU sign-off given.**

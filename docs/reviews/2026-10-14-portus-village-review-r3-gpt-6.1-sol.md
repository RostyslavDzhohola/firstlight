# Portus village review, round 3

Reviewed by GPT-6.1 Sol on 2026-10-14. Report only. This report is uncommitted; no repository code was edited.

Worktree `fl-wt-village`, branch `lane/portus-village`, exact reviewed tip `e3841ccfb9c62df96c2f849408e98dda5f68ed28`. Scope: `git diff 68e91cc..e3841cc`, covering `f4cc684`, `92a2f76` and `e3841cc`. HEAD was unchanged throughout the review. Read AGENTS.md, the round-2 code and browser reports, the diff and affected runtime paths.

**Findings: 0 blockers, 0 should-fix, 0 nits. S4 is closed.**

**Merge verdict: approve this follow-up at e3841cc.** The stand now blocks on the client and server, placement clears it, the plaza approach and a full walk around it work, and the last row clears the lower gold border. The owner's accepted dev-only offline invisible-stand limitation remains. This small review does not repeat the round-2 performance benchmark or supersede its separate performance/shader observations.

## Standards

Pass, 0 findings. Shared stand data stays deterministic and free of DOM/three, appends to the existing town solids and uses the existing placement logic. Server authority and the existing movement budget remain intact. The new tests exercise real server messages and compare rendered volumes with shared solids. No actionable documented-rule violation or baseline code smell found.

## Spec

Pass, 0 findings. `packages/shared/src/planet/town.ts:95` exports the common `HALL_BOARD` dimensions; `:101` defines five indestructible box solids covering the plinth, backing/frame, two posts and cornice. `:117` places them at authoritative `hall_wall`, facing the plaza, and `:149` appends them to `townSolids` with item/prefab `-1`. They stay outside `bodyBreakables`.

The real client route is `Game` → `PortusTown.moveColliders` → `PlayerController`; the real server's footing, crossing and placement use the same `structureCollider`. `apps/client/src/world/PortusTown.ts:398` omits these five boxes from fallback drawing because `QuestWorld` draws the stand. The accepted offline limitation is documented.

## S4 closure evidence

A review-only probe reran the former failing check against the actual `QuestWorld`, `PlayerController`, shared collider and in-process server. It joins through `/api/play` and SDK seat consumption and sends the real admin teleport/input messages. Results are in `s4-probe.json` under the artifact directory below.

- At the drawn plinth centre, local `(0, 0.05, 0)`, footing now reports inside and `resolve` pushes the player 0.61 m clear. Round 2 reported no collision there.
- The shared and drawn right/front axes differ by less than `3e-16`. All seven drawn solid meshes match the five collider envelopes within the existing centimetre-scale margin. The render root retains its 2 cm ground lift, and the brass bars extend 1 cm beyond the rear of the combined backing collider. These do not permit a player-sized pass-through.
- Admin teleport onto that centre relocates the player 0.632 m to clear ground. Twenty real controller frames settle there with **0 corrections**.
- A forced input path from 2.5 m in front through the board centre to 2.5 m behind produces **11 corrections across 20 packets**. After the final sequence is replicated, the player is outside the stand and remains 0.250 m on the plaza side. This deliberately invalid path tests server enforcement; ordinary client movement below produces no corrections.
- The shared tests retain spawn-to-board approach clearance and check blocking from both directions and ray interception. The client tests compare frame axes and every drawn solid volume.

## Headless browser check

Used the round-2 CDP harness with a newly created profile, headless Chrome 155 and Metal ANGLE on Apple M1. No desktop Chrome or computer use. Window 1600 × 900, DPR 1, Medium canvas 1360 × 765, real town assets, LOD0. The actual WebGPU adapter reports `apple`, `metal-3`, `isFallbackAdapter=false`; WebGL2 reports `ANGLE Metal Renderer: Apple M1`. No SwiftShader result was accepted.

LANE at `http://127.0.0.1:5621`, server `:2621`, used the reviewed worktree. Neither process was restarted or stopped. Retaken views reuse the round-2 approach coordinates, camera pitch and distance:

- `hall-board-plaza-webgpu.png`: approximately town `(-9.841, -4.921)`. Last row is above the gold border; stand and board remain visible from the plaza.
- `hall-board-close-webgl.png`: approximately `(-18.632, -10.655)`. The last label and right-hand claim both have a clear gap above the lower gold border. Heading remains fully inside the frame.
- Additional close WebGPU and plaza WebGL captures also pass. All four screenshots were opened and inspected.

Online guest `PortusR3QA` walked from the plaza toward the board centre with normal keyboard input. Holding forward for 3.5 s stops at approximately `(-20.272, -11.695)`, **0.610 m on the plaza side**, outside the collider. The guest then walks around both ends, through the gap behind the board and back to its front. All six circuit waypoints were reached within 0.22 m, outside solids. **0 corrections across the successful approach, blocked walk and full circuit**, with final input replication checked; server/client final positions agree within 0.00001 m.

The first circuit's rear waypoint was 1.5 m behind the board and hit the existing Hall steps. The corrected circuit uses the gap 0.8 m behind the board and passes. `around-first-attempt.json` retains that route diagnostic; it also recorded zero corrections. No game-code change was needed.

The sampled browser runs reported zero post-warm-up shader builds and no runtime exceptions. This is a small Hall check, not a new benchmark or broad shader sign-off. Headless fullscreen/audio gesture warnings are retained in the console logs.

## Validation

```text
pnpm typecheck
PASS: shared, server, client

pnpm vitest run packages/shared/src/planet/town.test.ts \
  apps/server/test/town.test.ts \
  apps/client/src/world/unload.test.ts \
  apps/client/src/world/portusTown.test.ts \
  apps/client/src/game/PlayerController.test.ts
PASS: 5 files, 51/51 tests, 22.83 s

pnpm vitest run --config /tmp/fl-portus-r3.config.mts
PASS: 1 review-only diagnostic, 3.39 s

git diff --check 68e91cc..e3841cc
PASS
```

The builder's full-suite result of 1,162/1,162 at e3841cc is supplied context, not independently rerun here. The diagnostic is outside the repository and is separate from the 51 repository tests.

## Artifacts and cleanup

Artifact directory: `~/Documents/Codex/2026-10-14/portus-village/round3/`.

Requested screenshots:

- `hall-board-plaza-webgpu.png`
- `hall-board-close-webgl.png`

Movement screenshots:

- `online-hall-stand-blocked.png`
- `online-hall-stand-around-back.png`
- `online-hall-stand-around.png`

Supporting outputs: `s4-probe.json`, `boards.json`, `board-webgpu.json`, `board-webgl.json`, `online-hall-stand.json`, `guest-final.json`, `hardware.json`, `validation.txt`, `scope.json`, `launch.json`, `console.json`, `network.json`, `cleanup.json` and `scripts/`. Review-only server probe source/config also remain at `/tmp/fl-portus-r3-probe.test.ts` and `/tmp/fl-portus-r3.config.mts`, with copies in the artifact scripts directory.

Only the newly launched headless Chrome process group, PID 6089, was stopped. The LANE listeners remain running. No commit, merge, deployment or publication was performed.

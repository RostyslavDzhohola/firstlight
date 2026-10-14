# Portus village review, round 1

Reviewed by GPT-6.1 Sol on 2026-10-14. Report only; no source edits, commits, merges or deployments.

Branch `lane/portus-village`, HEAD `a5c9fc2aaf2e159fa016d5489f7a6ffbd25911e3`; base `main` at `2fb1edfb6679605e0d004561cf66197be4f859d6`. Scope: `git diff main...lane/portus-village`, excluding binary asset diffs. Shipped binaries were hashed and decoded by the asset tests. Read AGENTS.md, `/tmp/fl-village-integration-brief.md`, the builder's 2026-10-12 review, and D38–D41. Standards and spec checks were reviewed separately, then findings ranked as requested.

**Findings: 1 blocker, 3 should-fix, 3 nits.**

**Merge verdict: no.** Resolve B1 and the loading/fallback defects before merging. Passing suites do not close the saved-position correction loop. Browser appearance, runtime texture upload, frame-rate budgets and post-warm-up shader counts remain unverified by this review.

## Blocker

### B1. Restoring a position inside a large structure traps the player in a correction loop

`apps/client/src/game/PlayerController.ts:243`, with `apps/server/src/world/BodyRoom.ts:394` and `apps/server/src/world/movement.ts:196`.

Arrival restores saved positions with terrain snapping only. The first controller update resolves the structures by pushing the player straight out of the enclosing building. That displacement can exceed the server's 3.5 m movement bank plus 0.05 m tolerance. The server permits leaving a solid but still charges that full displacement, refuses it as speed, and corrects the player back inside. Every subsequent update repeats the same push. This affects existing saves at coordinates newly occupied by the town, and admin/quest teleports there.

A direct controller/validator probe at the keep center `(east=0, north=52.6)` produced a 5.8300 m push and `{ok:false, reason:"speed"}`. Market Hall `(10.608,27.634)` pushed 4.7970 m; Hall of Firsts `(-27.453,-15.85)` pushed 4.0300 m, also refused. A smaller house at `(26.2,6.1)` pushed 2.5800 m and was accepted.

Confirmed through the real server path: seed a memory character save at the keep center, join Portus through `/api/play` and the SDK, run the real PlayerController, send five input packets, and feed each server correction back into `PlayerController.correct`. All five packets were corrected; server position remained at `(0,52.6)`. The server's grounded settle path does not move the actor out sideways. The builder's claim that saved positions are pushed out safely is therefore false for large structures.

Fix placement on the server: resolve restored/teleported positions against the shared structures before setting position and motion state. Do not grant arbitrary client movement a larger budget. Add a real-path saved-position/teleport test using the client-resolved position and subsequent correction handling. Brief §1 requires checking saved-world consequences; D39 requires agreement with an honest client.

## Should-fix

### S1. The 20-second arrival deadline leaves invisible walls and allows late shader builds

`apps/client/src/game/Game.ts:439`, `apps/client/src/world/PortusTown.ts:112`, `apps/client/src/render/townAssets.ts:80`.

The race bounds the wait, not the asset request or town build. If a manifest, GLB or strip request remains pending, arrival continues with the shared colliders enabled and an empty town group. Fallback only happens when the asset promise resolves null or mesh construction throws. A permanently hung promise also stays in the session's `pending` cache, so later arrivals reuse the same hang.

If the request completes after arrival, `buildCells` installs the town after the quality probe and shader warm-up. There is no second warm-up or pause before the meshes enter play. The probe can choose and persist a tier without measuring the town, and town pipelines may first compile during live play. Brief §5 requires the town to be "loaded before the first frame there and warmed up"; §6 targets "0 shader builds after warm-up."

Use an actual bounded load, select visible fallback before probe/warm-up, and cancel or ignore late completion. If replacing fallback later is desired, route replacement through a hidden warm-up and account for the probe result. Test a never-settling source and a source resolving after the deadline.

### S2. Fallback cylinders draw at twice their collider radius

`apps/client/src/world/PortusTown.ts:312` and `apps/client/src/world/PortusTown.ts:318`.

`CylinderGeometry(1,1,1,14)` has unit radius, while its instance basis scales horizontal axes by `hx*2` and `hz*2`. Cylinder solids use `hx` as their radius. A 3.65 m tower collider therefore draws a 7.30 m fallback cylinder. Players can stand visibly inside the fallback tower, and its oversized geometry covers walkable approaches. Boxes are correctly sized because their source width is 1.

Use radius-0.5 source cylinders or shape-specific instance scaling. Check transformed fallback bounds against the solids; the existing test counts instances only. D41 and the fallback comment promise geometry matching the colliders.

### S3. Server town tests stop observing before proving the last packet was processed

`apps/server/test/town.test.ts:43`.

The route helper waits a fixed 300 ms, removes its correction listener, then callers inspect replicated state. Under the documented shared-machine load, this does not establish that the final input was processed and replicated. It can miss late corrections or inspect an earlier position. AGENTS.md explicitly says "Wait on conditions, not fixed sleeps."

Keep the 50 ms sleeps that pace client packets, but wait for the final sent sequence in replicated state before removing the listener and asserting. The extra pre-route 300 ms waits at lines 55, 69 and 75 can also be replaced by relevant state conditions. Tests do drive the real message path, which is the right seam, but currently cover only a ground-level house and two walking routes, not saved positions, high-speed sweeps or top landings.

## Nits

- `docs/DECISIONS.md:411`: D38 says the vegetation merge left `PROPS_VERSION` at 3, while this lane explicitly changes it to 4. Update D38 to match the code and builder report.
- `tools/blender/portus/gen_town.py:35`: generated comments say the GLB carries the layout version. `pack.py:801` actually embeds numeric version `1`; the manifest carries `87ffea24f75d57e7`. Correct the comment or embed and check the actual layout version. Runtime validation checks manifest version and mesh triangle/slot sanity, not the shipped file SHA-256s, so do not describe it as full manifest-to-GLB identity verification.
- `packages/shared/src/content/portusTown.ts:112`: the new decorative target at `(12.2,-8.6)` overlaps slot 36 of a 40-person stage-1 ring. A scan of stage-1 formations for counts 1–40 found exactly one center inside a structure, at `(12.1353,-8.8168)` for count 40. Move this decorative prop or select collision-free stage positions. This is a small staging overlap; it is separate from B1's large-building trap.

## Authority, movement and dependent content checks

- Both sides call `structureCollider` over their shared `Terrain`; the render placements use `townPlacements` from the same generated layout. The server movement world combines structure footing/sweeps with breakables. The client uses the same solids and player dimensions. No duplicate hand-authored client/server structure set was found.
- Terrain changes are confined to `hubBase`; the only current hub is Portus. Executed main's terrain module from a temporary source snapshot and compared raw and rendered ground outputs for 10,000 deterministic directions on each other body. The 20,000 Float64 values per body were byte-identical to main. Arcadia SHA-256 `cca0659dcdcacf169b4daa3309e4aed8702483bf9cecabaf88b3def391457627`; Hollowmere `b31212fdcde97b1bd0f88509d115773e36024e10119ff99a2b0bc331924750c5`; Meridian `c1a36b29b17ab3160cfea8c1f785436b9396b2cc26efacce17693dfd83290dbe`. Far-Portus old-formula equality and the flat interior/rim tests passed. The 72 m boundary describes raw height; rendered triangles retain their normal small chord sag and boundary interpolation.
- The unchanged `breakables.test.ts` pins passed for all four bodies. Portus remains the empty list. The breakable refactor changes generic collider types, not layout generation or persistence keys; the frozen v2 props source is untouched.
- Shared tests passed fixed portal alignment, clear approaches, spawn ring, Juno, Hall plaque, training dummies, all street centerlines and gates, deterministic solids, step/wall-top support and wall raycasts. Their positions remain driven by existing shared objects and terrain. Quest/onboarding indices and positions were not reordered.
- Additional real-controller probes approached each of 25 thin fence solids for one second at 60, 30 and 20 fps, on foot with sprint and with simulated mounted gallop. None of the 150 approaches crossed a shared solid. This is a bounded straight-approach check, not exhaustive corner/latency testing. Normal gameplay cannot summon horses in Portus, which is entirely safe; leaving another body despawns its horse. Mounted prediction still uses the same structure resolver.
- Initial spawn and normal Portus respawn use the tested clear spawn ring. Restored/admin/quest positions remain subject to B1. Portus has no NPC system. Client tracer occlusion consults structures; server shot/NPC occlusion remains unchanged, as D39 explicitly allows for the all-safe, NPC-free hub.
- Bench code still samples the updated ground correctly, but its figure-eight and crowd movement ignore structures and can pass through buildings. The builder already disclosed this. Treat those runs as scripted renderer workloads, not proof of representative walking performance. Stage 1 has the small 40-person overlap listed above; other photo stages are on unchanged bodies.

## Protocol and client lifecycle checks

A real HTTP request with protocol 2 returned `409` and `{ok:false,error:"version",version:3}`. `Net.ts:37` automatically reloads once per server version using sessionStorage, then reports an error if the mismatch persists. There is no explicit reload prompt. For ordinary old tabs reconnecting after a server restart, this should fetch the new client; it does not admit an incompatible room state. The handshake gate is not a live-session check, so deployment must actually restart/disconnect old sessions as D40 assumes.

Client-first followed promptly by server is the documented sensible order: existing old sessions keep their old pair during the gap; fresh version-3 page loads temporarily fail to join the old server. Server-first would reject every old-client fresh join/reconnect until the new client arrives. No alternative deploy-order defect was found.

Successful-load lifecycle and settings paths look consistent: town construction precedes probe and warm-up; the warm-up hook forces both LODs; Game.applyGraphics pauses and rewarms after runtime tier changes. Shader tests build opaque/cutout and normal/flat variants for WebGPU and WebGL2. These tests generate shader source, not real GPU uploads or post-warm-up runtime builds. Leaving Portus disposes merged geometries and fallback instance resources; shared decoded assets, texture arrays and material variants intentionally remain cached for the session. Pending construction checks `disposed` before installing meshes.

Per-tier town-only geometry counts are 198,168 triangles at LOD0 and 146,219 at LOD1. Spawn-view tests report Low with 2 draws and no shadow draws; Medium/High/Ultra with 2 draws plus 2 shadow draws. Low always selects LOD1; other tiers switch beyond the town bounds with hysteresis. These are mesh/frustum calculations, not renderer counters or whole-scene budget measurements. Grass has both worker vertex masking and per-blade root masking; natural props use the town exclusion field and `PROPS_VERSION=4`. Relevant mask/placement tests passed.

## Asset pipeline and licences

Both local source archive hashes were recomputed and match build.sh and ASSETS.md. Village `e60dea67c10f30dccccfbff92a7933f5ea5cfe99be0e2a0fa5118cceabeec5c4`; nature `298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9`. Both archived licence texts grant CC0. ASSETS.md records Quaternius, creator source URLs, download date, licences and modifications.

build.sh verifies hashes before extracting into a fresh temporary directory. extract.py rejects traversal/absolute output paths and writes only permitted data extensions, without creating archive symlinks. The audited 244 kit glTF documents contain no remote, absolute or traversing URIs. Blender runs with autoexec disabled and factory startup; data-reading Python uses `-I`; no kit scripts are executed. Build randomness/Cycles seeds are fixed, and the compression CLI is selected from the pinned pnpm cache. A full byte-for-byte rebuild was not run because the default script overwrites shipped files. Reproducibility is supported by code inspection, not independently proven by rebuilding.

Recomputed shipped hashes, all matching ASSETS.md and the manifest where applicable:

| File | Bytes | SHA-256 |
|---|---:|---|
| portus.glb | 2,369,240 | `145edc386d1949c6d3f1cc044867c641d042f35b1091e7950c4f72b541c4165d` |
| portus_color.webp | 167,220 | `02997d204f4e42e14bbe7192e88af48797683f424ef8e4734cb1d3a816eafda6` |
| portus_normal.webp | 255,836 | `9658a29258d9c3112b8299510ff572c432116824aec6916ade7bcbb5bbf8d735` |
| manifest.json | 5,614 | `073f3bd899f4e338a21c3129b0a8e56bd9304931d55cab3ef26f07a158c44e34` |

Total 2,797,910 bytes, below the 6 MB target. Asset tests successfully meshopt-decoded every expected prefab/LOD and verified file hashes, strip dimensions and triangle counts.

## Tests

- `pnpm typecheck`: shared, server and client passed.
- Targeted run: **10 files, 97 tests passed**, 19.82 s. Files: shared `props`, `terrain`, `town`, `townGround`, and unchanged authoritative `breakables` pins; server `town`; client `PlayerController`, `shaders`, `townAssets`, `portusTown`.
- Full `pnpm test`, once: **126 files, 1,144 tests; 123 files/1,141 tests passed, 3 files/3 tests failed**, 127.68 s. Egg persistence timed out waiting for offering coins; horse test observed zero corrections where it expected a positive count; NPC control sprint observed three corrections where it expected zero. All three are on Arcadia and outside the Portus changes. A concurrent headless-browser task was reported by the owner.
- Isolated rerun `m11-egg-persistence.test.ts`: **16/16 passed**, 19.79 s.
- Isolated rerun `horses.test.ts`: **15/15 passed**, 28.28 s.
- Isolated rerun `npc.test.ts`: **25/25 passed**, 64.61 s. All three failing files passed individually, **56/56 tests** total. The aggregate full-suite run remains recorded as failed; isolated results support a load/timing explanation, not a claim of a green full run.
- Separate review probes reproduced B1 through real SDK input/correction handling, checked the protocol-2 refusal, compared other-body terrain with main, exercised thin-fence controller approaches and checked stage formations. These probes did not change repository source or add tests.

No browser was driven by this review. The builder's visual checklist still needs live WebGPU/WebGL2, shadercheck, texture upload, M1 Medium and throttled Low measurements, and actual scene draw/triangle counters. Another task's browser results must be assessed separately against this exact commit.

# lane/render review (Codex gpt-6.1-sol, high), 2026-10-12

Reviewed `lane/render` at `736e00f` (merge-base `9853521`), compared against main `fcc2073`. Read-only; no browser.

## Blocker
- Merge conflicts in `apps/client/src/game/Game.ts` and `packages/shared/src/index.ts`: integrate renderer changes into main's orchestration (`Planet(this.ctx, body)`, keep portals lifecycle, distance culling, `requestTravel`; export both props and portals). → Resolved in the merge on lane/ui (`ad65c0a`), recorded with rerere.

## Should-fix
1. Post rebuilds leak intermediate render targets (`post.ts:118`, implicit RTT from `fxaa(out)` never disposed). Fix: explicit `rtt(out)` registered for disposal; track other implicit RTTs.
2. Particle capacity changes leave old GPU buffers (`particles.ts:117`): dispose old geometry, swap in a new one.
3. Grass and props upload unchanged buffers every render (`grass.ts:193`, `props.ts:62`): `DynamicDrawUsage` forces uploads in r186; use version-driven usage and update ranges only on change.
4. GPU timing divides an already per-frame result (`timing.ts:44`): record `ms` directly.
5. Ladder stops adapting below ~10 fps (`timing.ts:101`): keep slow-frame samples, smaller minimum or accumulate across windows.
6. Default `?bench` doesn't exercise the G1 workload (`Game.ts:188`, `bench.ts:74`): add a named G1 preset (crowd + particles + 3-min warm-up), separate from the offline renderer bench.
7. Bench duration follows clamped sim time (`bench.ts:172`): drive phases from wall clock.
8. Dropping to Low doesn't rebake loaded terrain (`Planet.ts:149`, `terrain.worker.ts:110`): rebake on baked-sun change or always generate the data.
9. `?noshadows` leaves blob shadows on (`blobShadows.ts:46`): require `s.on.shadows && s.on.chars && mode === "blob"`.

## Nit
- F3 overlay gets clamped `dt` (`PerfOverlay.ts:72`): pass raw frame ms.

## Validation
- Client typecheck passed; `pnpm vitest run` 6 files / 52 tests passed. No `Math.random` in shared props; no chunk-boundary duplicates found. Backend rendering, M1 performance and G1 unverified (no browser).

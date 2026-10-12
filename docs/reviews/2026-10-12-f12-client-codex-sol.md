# Review: lane/f12-client, Codex gpt-6.1-sol

Reviewed `dd4ed12..e691c70`, all eight commits. Working tree remains clean.

## Blocker

None found.

## Should-fix

1. **First-boot removals leave no recovery screen.** `apps/client/src/main.ts:68`
   If 4100 ELSEWHERE, 4102 BANNED, or 4104 KICKED arrives during first-arrival loading or warm-up, `ArrivalWatch` throws `ConnectionLost`. `describeBootFailure()` returns `null`, so boot hides loading without calling `removedFromWorld()`. The landing page is already hidden and gameplay never starts. The harness reproduced all three codes with zero removal-screen calls.
   **Fix:** explicitly handle removal-coded `ConnectionLost` during first boot, showing the removal screen and stopping the game. Add a boot-to-screen integration test; the current helper test assumes that screen already exists.

2. **Collision allows dodges through fences and misses fast landings.** `apps/client/src/game/PlayerController.ts:176`
   Resolution uses only the position after movement. At 30 fps, a dodge from `z=-0.47` crosses a standard fence and resolves to `z=+0.470018`, retaining forward velocity. At 20 fps, falling at 20 m/s from just above a crate top pushes the player sideways instead of landing. Existing controller tests run exclusively at 60 Hz.
   **Fix:** sweep from the previous position, or substep movement within horizontal and vertical collision tolerances. Test low-frame-rate dodges and fast downward crossings of prop tops.

3. **The WebSocket join remains unbounded.** `apps/client/src/net/Net.ts:77`
   The new timeout covers `/api/play`, but not `consumeSeatReservation()`. If the socket connects and stalls before `JOIN_ROOM`, the installed SDK has no join deadline. `ArrivalWatch` is installed only after this await completes. A stubbed-handshake probe remained pending after 21 seconds, although the HTTP timeout signal had aborted.
   **Fix:** bound seat consumption too, close the timed-out connection, and prevent a late join from attaching after a retry. Test a socket that never completes its handshake.

4. **Standable prop tops conflict with server jump validation.** `apps/client/src/game/PlayerController.ts:187`, `apps/server/src/world/BodyRoom.ts:462`
   The client treats a prop top as ground, while the server measures jump height against terrain alone. From real Arcadia campwall `12.0`, one ordinary jump frame raises the player by 0.22 m to 2.634 m above terrain. The server rejects that movement and sends `correct`, cancelling the jump.
   **Fix:** recognize intact prop support in server height and grounded-state validation, and measure permitted jumps from that support. Add a client/server movement test for jumping from a wall top.

## Nit

1. **Smaller cylinders leave visible cap corners outside shot collision.** `packages/shared/src/planet/breakables.ts:50`
   The square statue base and pillar caps extend beyond the new cylinder radii. Downward rays at local statue `(0.36, 0.36)` and pillar `(0.32, 0.32)` intersect the rendered meshes but miss the new colliders; the previous colliders stopped both rays. The volume/extent test does not detect these holes.
   **Fix:** use box colliders for the caps plus cylinders for the shafts, and test representative mesh/collider ray agreement.

Normal mid-game ELSEWHERE/BANNED/KICKED closes stop rejoining; MERGED refreshes the token. Intentional `Net.leave()` callbacks are suppressed, so treating unexpected 1000/4000 closes as rejoin does not itself break logout or travel. No disposal or scratch-vector aliasing regression found on inspection.

Validation passed: `pnpm typecheck`, `pnpm --filter @firstlight/client build`, and 14 relevant Vitest files covering 77 tests. No timeouts. Scratch probes used no browser or live sites.

Merge: no

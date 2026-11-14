# Review: first-person view lane (`night/view` at `403cea8a`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** First-person melee can miss the crosshair direction, interactions remain
distance-only, and required coverage and the block-pose work are missing. No blockers.

## Findings

1. **Should-fix, `apps/client/src/game/PlayerController.ts:575`: first-person melee follows an eased body
   heading.** A controller probe confirmed a 66.8° heading error immediately after a 90° turn. Server melee
   uses `p.state.fx/fy/fz`, not the camera ray, so turning and swinging can attack beside the crosshair.
   The new test (`view.test.ts:185`) waits 30 frames before asserting alignment. Use the camera heading
   immediately for first-person gameplay facing and make sure the server has it before the melee message;
   ease the visible body separately. Test a turn and attack without the settling delay.
2. **Should-fix, `apps/client/src/voice/VoiceClient.ts:445`: push-to-talk on K conflicts with photo mode.**
   `PhotoMode.ts:197` uses K for time of day, and voice processes K without checking photo mode. In a
   voice-enabled build, changing the light can open voice setup or transmit. Suppress push-to-talk in photo
   mode or pick a free key; add a voice-enabled regression test.
3. **Should-fix, `apps/client/src/game/QuestClient.ts:142`: interactions do not follow the crosshair.**
   Selection considers reach and distance only. In first person a player can interact with an object behind
   them, or with a nearer one beside the one under the crosshair. Filter targets by the camera ray, keep
   the server's reach check, test two nearby targets with one under the crosshair.
4. **Should-fix, `apps/client/src/debug/e2eHook.ts:785`: the hook exists but no journey uses it.** No
   journey asserts first person through a fight; the Skipstep velocity and jump-clip changes have no
   targeted regression tests.
5. **Should-fix, `apps/client/src/render/Avatars.ts:906`: #76's block pose is not implemented.**

## Checked and sound

`pnpm typecheck` passed; `pnpm vitest run --project client` 1,471 passed, 3 skipped. Server and protocol
rules unchanged: ranged fire still sends the camera origin and direction, spells keep their message shapes
and server validation. Read: persistence, the death override, mounting, portal and reconnect controller
reuse, photo and map paths, collision math, head masking, the five stills. Camera vectors are reused,
though small per-frame objects were added.

## Not checked

Browser journeys, live first-person combat, mounted framing, worst-corner collision sweeps, the videos,
WebGL2 rendering, measured frame-time or allocation cost.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | First person on foot: the gameplay facing is the camera heading on the frame of a turn (only the drawn `bodyFacing` eases); `Net.flushInput` sends the held-back input before each melee, so the server's arc reads this frame's facing. Tests: `view.test.ts` (turn 90°, no settling), `Net.test.ts` (input flushed before `melee`). D-fix-view-1. | `d06559e7` |
| 2 | Photo mode counts as both talk keys released (like typing): K/B there never open the mic or voice setup; entering photo mode with K held goes off air. Voice-enabled test `voice/pushToTalk.test.ts`. D-fix-view-2. | `d9663b22` |
| 3 | E takes the in-reach object nearest the crosshair ray within a 40° cone (`game/interactTarget.ts`), both views; first person takes nothing outside the cone, third person falls back to the nearest. Server reach check unchanged. D-view-6. | `b52c0213` |
| 4 | Journey `e2e/j8-first-person.spec.ts` (J8.1): V in (mode and blend at 1), a melee fight won in first person (server-confirmed hits, kill XP, camera in first person throughout), V out; passed on webgpu and webgl. Unit tests for #78: `PlayerController.resumeAfterBlink` (a jump blinked 26 ms in lasts and peaks like a plain one), `AvatarView.blinked` (no rez-in), `fallClip` (a hop keeps `jump_air`). | `94e78c1a`, `2e07fdd1` |
| 5 | #76: while `block_hold` plays the Riverstaff turns in the hand (`Avatars.ts` `BLOCK_GRIP_DEG`, eased 0.15 s), lying across the guard; clip check over the held frames clear on both Kappa looks (was 4.1 cm into Kappa B's pelvis), renders from three sides clear of the hat brim and shell. D-fix-view-3. | `caf05f5c`, `54de606f` |

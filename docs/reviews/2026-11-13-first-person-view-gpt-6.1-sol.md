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
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |

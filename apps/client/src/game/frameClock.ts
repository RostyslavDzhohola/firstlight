// How much game time a rendered frame advances (#33). It used to be clamped to 50 ms, so below
// 20 fps the whole game ran in slow motion (at 4 fps, 8 s of sprinting counted as 0.9 s). Now a slow
// frame advances in full up to 250 ms on foot (4 fps keeps real time) and 200 ms in the saddle
// (5 fps), split into steps of at most 50 ms for movement and springs. The ceiling is the server's
// movement check (D3, apps/server/src/world/movement.ts): it refills at most 250 ms of movement per
// input packet and banks 3.5 m on foot, 5 m in the saddle, and one packet per frame has to fit with
// network jitter. A 250 ms sprint (2.25 m) does; a 250 ms gallop (4 m) doesn't, with packets 70 ms
// early or late, and 200 ms (3.2 m) does (D-fixes-1). Slower than that the game runs a little slow
// (75 % at 3 fps on foot). A gap over a second (hidden tab, debugger, travel) isn't caught up at all:
// it counts as one 50 ms step, as before.

/** Longest movement (or spring) step (s). */
export const FRAME_STEP_S = 0.05;
/** Most game time one frame may advance on foot (s). */
export const FRAME_MAX_S = 0.25;
/** Most game time one frame may advance in the saddle (s): a gallop step must fit the horse's bank. */
export const FRAME_MAX_RIDE_S = 0.2;
/** A frame longer than this (s) is a gap, not a slow frame. */
export const FRAME_GAP_S = 1;

/** How many equal steps of at most FRAME_STEP_S cover `dt` seconds. */
export function stepsFor(dt: number): number {
  return Math.max(1, Math.ceil(dt / FRAME_STEP_S - 1e-9));
}

/** Game time (s) for a frame that took `rawMs` of wall time, and how many movement steps it splits into. */
export function frameClock(rawMs: number, maxS = FRAME_MAX_S): { dt: number; steps: number } {
  const s = Math.max(0, rawMs / 1000);
  if (s > FRAME_GAP_S) return { dt: FRAME_STEP_S, steps: 1 };
  const dt = Math.min(maxS, s);
  return { dt, steps: stepsFor(dt) };
}

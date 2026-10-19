// How much game time a rendered frame advances (#33). It used to be clamped to 50 ms, so below
// 20 fps the whole game ran in slow motion (at 4 fps, 8 s of sprinting counted as 0.9 s). Now a
// slow frame advances in full, split into steps of at most 50 ms for movement, up to 250 ms a
// frame: the server refills movement for at most 250 ms per input packet and banks 3.5 m
// (apps/server/src/world/movement.ts, MOVE.budgetCap), so one packet can't carry more (D3). A gap
// over a second (hidden tab, debugger, travel) isn't caught up at all: it counts as one 50 ms step,
// as before.

/** Longest movement step (s). */
export const FRAME_STEP_S = 0.05;
/** Most game time one frame may advance (s). */
export const FRAME_MAX_S = 0.25;
/** A frame longer than this (s) is a gap, not a slow frame. */
export const FRAME_GAP_S = 1;

/** Game time (s) for a frame that took `rawMs` of wall time, and how many movement steps it splits into. */
export function frameClock(rawMs: number): { dt: number; steps: number } {
  const s = Math.max(0, rawMs / 1000);
  if (s > FRAME_GAP_S) return { dt: FRAME_STEP_S, steps: 1 };
  const dt = Math.min(FRAME_MAX_S, s);
  return { dt, steps: Math.max(1, Math.ceil(dt / FRAME_STEP_S - 1e-9)) };
}

// "You were hit from": where on the screen's ring a hit came from (D-ui-4). Pure maths: the
// attacker's direction in the camera's own frame, as an angle round the crosshair (0 = ahead / top of
// the ring, clockwise: 90° = from the right, 180° = from behind). ui/momentsView.ts draws the wedge.

type V3 = { x: number; y: number; z: number };

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The angle (degrees, 0–360, clockwise from "ahead") of `from` as seen by a camera at `eye` looking
 * along `forward` with `right` to its right. Height is ignored: the ring is the ground plane round
 * the player. Returns null when the source is on top of the camera (no direction to show).
 */
export function hitAngle(eye: V3, forward: V3, right: V3, from: V3): number | null {
  const d = { x: from.x - eye.x, y: from.y - eye.y, z: from.z - eye.z };
  const f = dot(d, forward);
  const r = dot(d, right);
  if (f * f + r * r < 1e-6) return null;
  const deg = (Math.atan2(r, f) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Hits from within this many degrees of a wedge already showing refresh it instead of adding one. */
export const HIT_MERGE_DEG = 25;
export const HIT_FROM_MS = 1100;
export const HIT_FROM_MAX = 4;

export function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

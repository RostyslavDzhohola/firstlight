// Compass math on a sphere. North is the game's pole frame (D38, content/places.ts tangentFrame,
// planet/townFrame.ts): toward the body's +Z pole along the surface, so at the Portus town centre
// (+Y) north is +Z and east is -X. The compass, the map and the minimap all take north from here.
// Bearings are clockwise in degrees, 0 = straight ahead / north.

export type V3 = readonly [number, number, number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** `v` projected onto the tangent plane at unit `up`. */
const tangent = (v: V3, up: V3): V3 => {
  const k = dot(v, up);
  return [v[0] - k * up[0], v[1] - k * up[1], v[2] - k * up[2]];
};

export function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Unit tangent pointing north at `pos` (toward +Z; at the ±Z poles themselves, toward +Y). */
export function northAt(pos: V3): V3 {
  const up = norm(pos);
  const ref: V3 = Math.abs(up[2]) > 0.99999 ? [0, 1, 0] : [0, 0, 1];
  return norm(tangent(ref, up));
}

/** Unit tangent pointing east at `pos`: north × up, so east is on the right when you face north. */
export function eastAt(pos: V3): V3 {
  return cross(northAt(pos), norm(pos));
}

/** Signed angle (degrees, clockwise = right) from `forward` to the surface direction of `target`. */
export function bearingTo(pos: V3, forward: V3, target: V3): number {
  const up = norm(pos);
  const f = norm(tangent(forward, up));
  const right = cross(f, up);
  const d = tangent([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]], up);
  return (Math.atan2(dot(d, right), dot(d, f)) * 180) / Math.PI;
}

/** Compass heading of `forward` (degrees clockwise from north, 0..360). */
export function headingOf(pos: V3, forward: V3): number {
  const n = northAt(pos);
  const p: V3 = [pos[0] + n[0], pos[1] + n[1], pos[2] + n[2]];
  return (((-bearingTo(pos, forward, p)) % 360) + 360) % 360;
}

/** Great-circle distance in metres between two points on a sphere of radius r. */
export function surfaceDistance(a: V3, b: V3, r: number): number {
  const c = Math.max(-1, Math.min(1, dot(norm(a), norm(b))));
  return Math.acos(c) * r;
}

/** Nearest direction (unit vectors) to `pos`. */
export function nearestDir(pos: V3, dirs: readonly V3[]): number {
  const up = norm(pos);
  let best = -1;
  let bestDot = -Infinity;
  dirs.forEach((d, i) => {
    const k = dot(up, d);
    if (k > bestDot) {
      bestDot = k;
      best = i;
    }
  });
  return best;
}

/** Horizontal position (0..1) on a strip spanning ±halfSpan degrees; clamped flag when off-strip. */
export function stripX(relDeg: number, halfSpan: number): { x: number; clamped: boolean } {
  const r = wrapDeg(relDeg);
  const clamped = Math.abs(r) > halfSpan;
  const c = Math.max(-halfSpan, Math.min(halfSpan, r));
  return { x: 0.5 + c / (2 * halfSpan), clamped };
}

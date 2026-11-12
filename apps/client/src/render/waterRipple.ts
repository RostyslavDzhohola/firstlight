// The water ripples' maths, on numbers (planet graphics review, finding 2). The shader (water.ts)
// states the same formulas in TSL with these constants; water.test.ts checks them here.
//
// The ripples used to read two noise channels as slopes along a tangent frame built from a
// reference axis, world Y, or X where the surface faces within 18° of Y. The slopes stayed while
// the frame turned, so the normal jumped on the two circles where the axis switched
// (|up.y| = 0.95). Now the noise is a vector in world space, the same whichever way the surface
// faces, and the surface takes the part of it that lies in its own plane: no frame, nothing to switch.

export type Vec3 = readonly [number, number, number];

/**
 * A rotation that spreads the three centred noise channels (fine, coarse, speckle) over the world
 * axes, so every lake gets the same mix of them wherever it lies on the planet. Rows are
 * orthonormal: the vector is as long as the channels'.
 */
export const RIPPLE_MIX: readonly [Vec3, Vec3, Vec3] = [
  [2 / 3, 2 / 3, -1 / 3],
  [2 / 3, -1 / 3, 2 / 3],
  [-1 / 3, 2 / 3, 2 / 3],
];

/** The detail noise's ridged channel (B) isn't centred on 0.5: its mean, and the rain chop's gain on it. */
export const CHOP_MEAN = 0.88;
export const CHOP_GAIN = 8;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The world-space ripple vector of one noise tap (its R, G and A channels, 0..1). */
export function rippleVector(r: number, g: number, a: number): Vec3 {
  const c: Vec3 = [r - 0.5, g - 0.5, a - 0.5];
  return [dot(RIPPLE_MIX[0], c), dot(RIPPLE_MIX[1], c), dot(RIPPLE_MIX[2], c)];
}

/** The part of `v` in the surface's tangent plane (`up`: the unit surface normal). */
export function tangentPart(up: Vec3, v: Vec3): Vec3 {
  const d = dot(v, up);
  return [v[0] - up[0] * d, v[1] - up[1] * d, v[2] - up[2] * d];
}

/**
 * Rain chop from the same tap: the ripple vector turned a quarter round the normal and scaled by
 * the ridged channel about its mean, so it is a finer pattern of its own with no steady lean.
 */
export function chopTilt(up: Vec3, v: Vec3, b: number): Vec3 {
  const k = (b - CHOP_MEAN) * CHOP_GAIN;
  return [(up[1] * v[2] - up[2] * v[1]) * k, (up[2] * v[0] - up[0] * v[2]) * k, (up[0] * v[1] - up[1] * v[0]) * k];
}

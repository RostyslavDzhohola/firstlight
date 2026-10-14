// Portus town frame math (D38), pure and dependency-free so the prop placement (props.ts) and the
// render masks (townGround.ts) can use it without the collider modules. Pole frame: up = +Y,
// east = -X, north = +Z (the frame content/places.ts uses at the pole); east/north are geodesic
// (arc-length) offsets; a placed item's frame is the pole frame carried along the great circle
// (minimal rotation) and turned by its yaw (degrees, counter-clockwise seen from above; 0 = the
// prefab's front faces south).

type V3 = [number, number, number];


/** Pole frame: up, east, north (planet space). */
export const TOWN_UP: readonly [number, number, number] = [0, 1, 0];
export const TOWN_EAST: readonly [number, number, number] = [-1, 0, 0];
export const TOWN_NORTH: readonly [number, number, number] = [0, 0, 1];

/** Unit direction of the town point (east, north) on a body of `radius` (azimuthal equidistant). */
export function townDir(east: number, north: number, radius: number, out: V3 = [0, 0, 0]): V3 {
  const r = Math.hypot(east, north);
  if (r < 1e-9) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  }
  const t = r / radius;
  const s = Math.sin(t) / r;
  // tangent = east·E + north·N = (-east, 0, north)
  out[0] = -east * s;
  out[1] = Math.cos(t);
  out[2] = north * s;
  return out;
}

/** Town coordinates (east, north, geodesic metres) of a planet-space point (any length). */
export function townCoords(x: number, y: number, z: number, radius: number, out: [number, number] = [0, 0]): [number, number] {
  const l = Math.hypot(x, y, z);
  const h = Math.hypot(x, z);
  if (!(l > 0) || h < 1e-12) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const t = Math.atan2(h, y) * radius;
  out[0] = (-x / h) * t;
  out[1] = (z / h) * t;
  return out;
}

/** A placed prefab: base on the ground and its frame (right x, up y, front z), all planet space. */
export interface TownPlacement {
  item: number;
  prefab: number;
  scale: number;
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fy: number; fz: number;
}

/**
 * Frame of a town item: the pole frame carried to (east, north) along the great circle, turned by
 * `yawDeg`. Writes right/up/front into `out` (position untouched).
 */
export function townFrame(east: number, north: number, yawDeg: number, radius: number, out: TownPlacement): TownPlacement {
  const up = townDir(east, north, radius);
  const a = (yawDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // At the pole: right = cos·E + sin·N = (-c, 0, s); front = sin·E - cos·N = (-s, 0, -c).
  let rx = -c, ry = 0, rz = s;
  let fx = -s, fy = 0, fz = -c;
  const r = Math.hypot(east, north);
  if (r > 1e-9) {
    // Radial unit ρ (pole tangent toward the point), axis k = U0 × ρ; the rotation by t = r / R maps
    // ρ → cos t ρ - sin t U0 and keeps k.
    const qx = -east / r, qz = north / r; // ρ = (qx, 0, qz)
    const kx = qz, kz = -qx; // U0 × ρ = (0,1,0) × (qx,0,qz) = (qz, 0, -qx)
    const t = r / radius;
    const ct = Math.cos(t), st = Math.sin(t);
    const carry = (vx: number, vz: number): V3 => {
      const a1 = vx * qx + vz * qz; // ρ part
      const b1 = vx * kx + vz * kz; // k part
      return [a1 * ct * qx + b1 * kx, -a1 * st, a1 * ct * qz + b1 * kz];
    };
    [rx, ry, rz] = carry(rx, rz);
    [fx, fy, fz] = carry(fx, fz);
  }
  out.rx = rx; out.ry = ry; out.rz = rz;
  out.ux = up[0]; out.uy = up[1]; out.uz = up[2];
  out.fx = fx; out.fy = fy; out.fz = fz;
  return out;
}

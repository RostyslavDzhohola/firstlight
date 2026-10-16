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

// ------------------------------------------------------------------------------------ site frames

/**
 * A site anchor's frame: up, east, north (planet space). The pole-frame vector (x, y, z) maps to
 * east·(-x) + up·y + north·z (the pole frame has east = -X, up = +Y, north = +Z).
 */
export interface SiteAnchor {
  up: readonly [number, number, number];
  east: readonly [number, number, number];
  north: readonly [number, number, number];
}

/** content/places.ts tangentFrame at `up`, as a site anchor. */
export function siteAnchor(up: readonly [number, number, number]): SiteAnchor {
  const ref = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * up[0] + ref[1]! * up[1] + ref[2]! * up[2];
  let nx = ref[0]! - k * up[0], ny = ref[1]! - k * up[1], nz = ref[2]! - k * up[2];
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= l; ny /= l; nz /= l;
  // east = north × up
  const east: V3 = [ny * up[2] - nz * up[1], nz * up[0] - nx * up[2], nx * up[1] - ny * up[0]];
  return { up: [up[0], up[1], up[2]], east, north: [nx, ny, nz] };
}

/** The Portus pole: the identity rotation of the town frame. */
export const POLE_ANCHOR: SiteAnchor = { up: [0, 1, 0], east: [-1, 0, 0], north: [0, 0, 1] };

function rotate(a: SiteAnchor, x: number, y: number, z: number, out: V3): V3 {
  out[0] = -a.east[0] * x + a.up[0] * y + a.north[0] * z;
  out[1] = -a.east[1] * x + a.up[1] * y + a.north[1] * z;
  out[2] = -a.east[2] * x + a.up[2] * y + a.north[2] * z;
  return out;
}

const _r: V3 = [0, 0, 0];

/** Unit direction of site point (east, north) (geodesic metres from the anchor) on a body of `radius`. */
export function siteDir(a: SiteAnchor, east: number, north: number, radius: number, out: V3 = [0, 0, 0]): V3 {
  townDir(east, north, radius, _r);
  return rotate(a, _r[0], _r[1], _r[2], out);
}

/** Site coordinates (east, north geodesic metres) of a planet-space point (any length). */
export function siteCoords(a: SiteAnchor, x: number, y: number, z: number, radius: number, out: [number, number] = [0, 0]): [number, number] {
  // Into the pole frame (the inverse rotation: the transpose).
  const px = -(a.east[0] * x + a.east[1] * y + a.east[2] * z);
  const py = a.up[0] * x + a.up[1] * y + a.up[2] * z;
  const pz = a.north[0] * x + a.north[1] * y + a.north[2] * z;
  return townCoords(px, py, pz, radius, out);
}

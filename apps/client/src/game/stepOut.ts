// Step-out for the local player (#34): a pocket among solids that walking can't leave. The feet
// stand clear there, but every way out is undone: a column on a low plinth (the Hall of Firsts) shoves
// the body back into the plinth's side, and a top is only stepped onto from within half a body
// radius of its edge, which no walking step gets to. The player dropped in (off the plinth, or with
// a jump) and, without jumping, could only push against it. Pinned there, they go to the nearest
// clear spot a straight step reaches without going through a solid, close enough for the server's
// move check (its bank refills while the player stands pinned).

import type * as THREE from "three/webgpu";
import { emptyContact, type PropContact, type XYZ } from "@firstlight/shared/planet/collide";

/** Furthest step-out (m): within the server's 3.5 m move bank, which is full after a pinned half second. */
export const STEP_OUT_MAX = 1.5;
/** The rings searched round the feet (m apart) and the bearings on each. */
const RING_STEP = 0.25;
const BEARINGS = 24;
/** The walk tried each way out of a pocket: this many substeps of the controller's length (m). */
const PROBE_STEPS = 5;
const PROBE_STEP = 0.1;
const PROBE_WAYS = 16;
/** A way out gets the feet at least this far (m) in PROBE_STEPS. */
const PROBE_GAIN = 0.25;

/** What a step-out asks of a body's solids (StructureCollider and NatureSolids both answer). */
export interface StepOutSolids {
  resolve(p: XYZ, out: PropContact): boolean;
  isClear(p: XYZ): boolean;
  crosses(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

type GroundR = (x: number, y: number, z: number) => number;

const _q: XYZ = { x: 0, y: 0, z: 0 };
const _w: XYZ = { x: 0, y: 0, z: 0 };
const _c = emptyContact();
/** The tangent basis at the feet: a, b. */
const _a: XYZ = { x: 0, y: 0, z: 0 };
const _b: XYZ = { x: 0, y: 0, z: 0 };

function basis(p: XYZ) {
  const l = Math.hypot(p.x, p.y, p.z);
  const ux = p.x / l, uy = p.y / l, uz = p.z / l;
  const rx = Math.abs(uz) < 0.9 ? 0 : 1, rz = Math.abs(uz) < 0.9 ? 1 : 0;
  const k = rx * ux + rz * uz;
  const ax = rx - k * ux, ay = -k * uy, az = rz - k * uz;
  const al = Math.hypot(ax, ay, az);
  _a.x = ax / al;
  _a.y = ay / al;
  _a.z = az / al;
  _b.x = uy * _a.z - uz * _a.y;
  _b.y = uz * _a.x - ux * _a.z;
  _b.z = ux * _a.y - uy * _a.x;
}

/** `q` onto the ground under it. */
function snap(q: XYZ, groundR: GroundR) {
  const l = Math.hypot(q.x, q.y, q.z);
  const g = groundR(q.x / l, q.y / l, q.z / l) / l;
  q.x *= g;
  q.y *= g;
  q.z *= g;
}

/**
 * Can feet at `p` walk out, the way the controller walks (short steps, pushed out of the solids
 * after each), in any of PROBE_WAYS directions? Tops count as ground here; that only makes it
 * stricter about calling a spot a pocket.
 */
export function canWalkOut(solids: StepOutSolids, groundR: GroundR, p: XYZ): boolean {
  basis(p);
  for (let i = 0; i < PROBE_WAYS; i++) {
    const t = (i / PROBE_WAYS) * Math.PI * 2;
    const dx = _a.x * Math.cos(t) + _b.x * Math.sin(t), dy = _a.y * Math.cos(t) + _b.y * Math.sin(t), dz = _a.z * Math.cos(t) + _b.z * Math.sin(t);
    _w.x = p.x;
    _w.y = p.y;
    _w.z = p.z;
    for (let k = 0; k < PROBE_STEPS; k++) {
      _w.x += dx * PROBE_STEP;
      _w.y += dy * PROBE_STEP;
      _w.z += dz * PROBE_STEP;
      snap(_w, groundR);
      solids.resolve(_w, _c);
    }
    if (Math.hypot(_w.x - p.x, _w.y - p.y, _w.z - p.z) >= PROBE_GAIN) return true;
  }
  return false;
}

/**
 * Feet `pos` in a pocket of `solids` (no walking way out: canWalkOut): move them to the nearest
 * clear spot on the ground (`groundR`: the ground's distance from the planet centre along a unit
 * direction), or on a top there, that a straight step reaches without crossing a solid and that
 * isn't a pocket itself: rings RING_STEP apart out to STEP_OUT_MAX, in a fixed order. False, and
 * `pos` untouched, when the feet can walk out or no such spot is near enough.
 */
export function stepOut(solids: StepOutSolids, groundR: GroundR, pos: THREE.Vector3): boolean {
  if (canWalkOut(solids, groundR, pos)) return false;
  for (let d = RING_STEP; d <= STEP_OUT_MAX + 1e-9; d += RING_STEP) {
    for (let i = 0; i < BEARINGS; i++) {
      basis(pos);
      const t = (i / BEARINGS) * Math.PI * 2;
      const c = Math.cos(t) * d, sn = Math.sin(t) * d;
      _q.x = pos.x + _a.x * c + _b.x * sn;
      _q.y = pos.y + _a.y * c + _b.y * sn;
      _q.z = pos.z + _a.z * c + _b.z * sn;
      snap(_q, groundR);
      // Standing on a top there (a plinth): its height, as the controller would stand.
      _w.x = _q.x;
      _w.y = _q.y;
      _w.z = _q.z;
      solids.resolve(_w, _c);
      const l = Math.hypot(_q.x, _q.y, _q.z);
      if (!_c.pushed && _c.floor > l) {
        _q.x *= _c.floor / l;
        _q.y *= _c.floor / l;
        _q.z *= _c.floor / l;
      }
      if (!solids.isClear(_q) || solids.crosses(pos.x, pos.y, pos.z, _q.x, _q.y, _q.z) || !canWalkOut(solids, groundR, _q)) continue;
      pos.set(_q.x, _q.y, _q.z);
      return true;
    }
  }
  return false;
}

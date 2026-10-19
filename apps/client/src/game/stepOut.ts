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
/** A way out gets the feet at least this far (m, along the ground) in PROBE_STEPS. */
const PROBE_GAIN = 0.25;
/** Spots checked for being a pocket themselves, per step-out (each is up to PROBE_WAYS walks). */
const CANDIDATE_BUDGET = 8;

/** What a step-out asks of a body's solids (StructureCollider and NatureSolids both answer). */
export interface StepOutSolids {
  resolve(p: XYZ, out: PropContact): boolean;
  isClear(p: XYZ): boolean;
  crosses(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

type GroundR = (x: number, y: number, z: number) => number;

/** Two sets of solids as one (a body's structures and its natural solids: the server checks moves against both). */
export function bothSolids(a: StepOutSolids, b: StepOutSolids): StepOutSolids {
  const contact = emptyContact();
  return {
    resolve(p, out) {
      const moved = a.resolve(p, out);
      const floor = out.floor;
      if (b.resolve(p, contact)) {
        out.pushed = true;
        out.nx = contact.nx;
        out.ny = contact.ny;
        out.nz = contact.nz;
      }
      out.floor = Math.max(floor, contact.floor);
      return moved || contact.pushed;
    },
    isClear: (p) => a.isClear(p) && b.isClear(p),
    crosses: (ax, ay, az, bx, by, bz) => a.crosses(ax, ay, az, bx, by, bz) || b.crosses(ax, ay, az, bx, by, bz),
  };
}

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

/** `q` onto the ground, pushed out of the solids, and onto a top it stands over: where the controller would put feet there. */
function stand(solids: StepOutSolids, groundR: GroundR, q: XYZ) {
  snap(q, groundR);
  solids.resolve(q, _c);
  const l = Math.hypot(q.x, q.y, q.z);
  if (_c.floor > l) {
    q.x *= _c.floor / l;
    q.y *= _c.floor / l;
    q.z *= _c.floor / l;
  }
}

/**
 * Can feet at `p` walk out, the way the controller walks (short steps, pushed out of the solids
 * after each, standing on a top where there is one), in any of PROBE_WAYS directions? Progress is
 * measured along the ground: stepping down off a top isn't a way out by itself.
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
      stand(solids, groundR, _w);
    }
    const ex = _w.x - p.x, ey = _w.y - p.y, ez = _w.z - p.z;
    const l = Math.hypot(p.x, p.y, p.z);
    const radial = (ex * p.x + ey * p.y + ez * p.z) / l;
    if (Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - radial * radial)) >= PROBE_GAIN) return true;
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
  let budget = CANDIDATE_BUDGET;
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
      if (!solids.isClear(_q) || solids.crosses(pos.x, pos.y, pos.z, _q.x, _q.y, _q.z)) continue;
      if (budget-- <= 0) return false; // ringed by pockets: give up (a jump still gets out)
      if (!canWalkOut(solids, groundR, _q)) continue;
      pos.set(_q.x, _q.y, _q.z);
      return true;
    }
  }
  return false;
}

// Natural props as solids (D-solid-1): tree trunks, boulders, spires and the bigger rocks block
// movement for the client controller, the server's movement validator and NPC steering alike. They
// come from the same deterministic placement the client draws (props.ts solidChunkProps), built
// lazily per terrain chunk and cached per body; a query looks at the chunks round its point and
// allocates nothing once those are built (warm() builds them ahead of time, a few per call).
// Combat ignores them: shots and sight pass between the trunks as before.

import { BreakableCollider, emptyContact, PLAYER_BODY, pushOutOfBreakable, resetContact, supportHeightAt, type PropContact, type XYZ } from "./collide.ts";
import type { SolidFrame } from "./breakables.ts";
import { faceOf, faceUV, type Face } from "./cubesphere.ts";
import { propSolid, solidChunkProps, type PropKind } from "./props.ts";
import type { Terrain } from "./terrain.ts";
import type { BodyId } from "./bodies.ts";

export interface NatureSolid extends SolidFrame {
  kind: PropKind;
}

/** A body for the queries: radius, height and the step band (feet within it over a top stand on it). */
export interface SolidBody {
  radius: number;
  height: number;
  step: number;
}

/** The widest natural solid (a big spire: 1.8 × 1.6 × 0.85 m) plus slack: how far round a point to look for chunks. */
const MAX_SOLID_RADIUS = 2.6;
/** Feet pushed out further than their radius plus this are "inside" a solid (the server refuses the move). */
const INSIDE_MARGIN = 0.1;
/** A body 2 cm wider for clearSpot, like the structures' (no push of its own after float rounding). */
const CLEAR_MARGIN = 0.02;
/**
 * Colliders stop this high (m): a body is 1.8 m and a jump 1.2 m, and the tallest top anyone can
 * stand on (a big boulder, 3.5 m) is still more than a jump below it. Tree and spire collider tops
 * above it would only widen every query's broadphase (their bounding spheres).
 */
export const SOLID_MAX_HEIGHT = 5;
/** Natural solids at least this wide stop the camera (boulders, spires); trunks don't. */
export const CAMERA_SOLID_RADIUS = 1.2;

const always = () => true;
type Collider = BreakableCollider<NatureSolid>;

/** Solids of one chunk, from its solid props (cylinders standing on their surface points). */
function chunkSolids(terrain: Terrain, face: Face, cx: number, cy: number): NatureSolid[] {
  const out: NatureSolid[] = [];
  for (const p of solidChunkProps(terrain, face, cx, cy)) {
    const s = propSolid(p.kind, p.scale)!;
    const l = Math.hypot(p.x, p.y, p.z);
    const ux = p.x / l, uy = p.y / l, uz = p.z / l;
    // Any tangent frame will do for an upright cylinder.
    const ref = Math.abs(uz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0]! * ux + ref[1]! * uy + ref[2]! * uz;
    let fx = ref[0]! - k * ux, fy = ref[1]! - k * uy, fz = ref[2]! - k * uz;
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl; fy /= fl; fz /= fl;
    const rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
    const height = Math.min(s.height, SOLID_MAX_HEIGHT);
    const half = height / 2;
    out.push({
      index: out.length, kind: p.kind,
      px: p.x, py: p.y, pz: p.z,
      rx, ry, rz, ux, uy, uz, fx, fy, fz,
      shape: 1, hx: s.radius, hz: s.radius, h: height,
      cx: p.x + ux * half, cy: p.y + uy * half, cz: p.z + uz * half,
      bound: Math.hypot(s.radius, half),
    });
  }
  return out;
}

export class NatureSolids {
  readonly terrain: Terrain;
  private readonly cpf: number;
  private readonly chunks = new Map<number, Collider | null>();
  /** Chunks round the last query point (reused). */
  private readonly cols: Collider[] = [];
  private readonly keys: number[] = [];
  private readonly uv: [number, number] = [0, 0];
  private readonly contact: PropContact = emptyContact();
  private readonly scratch: XYZ = { x: 0, y: 0, z: 0 };
  private readonly candidates: number[] = [];
  private readonly footingOut = { top: 0, inside: false };
  private readonly a: XYZ = { x: 0, y: 0, z: 0 };
  private readonly b: XYZ = { x: 0, y: 0, z: 0 };
  private readonly clearQ: XYZ = { x: 0, y: 0, z: 0 };
  private readonly supportBody = { radius: 0, step: 0 };
  /** raycast()'s size filter (no closure per call). */
  private rayList: readonly NatureSolid[] = [];
  private rayMin = 0;
  private readonly wideEnough = (j: number) => this.rayList[j]!.hx >= this.rayMin;
  /** Solids built so far (all chunks), and chunks built. */
  solidCount = 0;
  builtChunks = 0;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    this.cpf = terrain.body.chunksPerFace;
  }

  private key(face: number, cx: number, cy: number): number {
    return face * 65536 + cy * 256 + cx;
  }

  /** The collider of chunk (face, cx, cy), built on first use (null: no solids there). */
  chunk(face: Face, cx: number, cy: number): Collider | null {
    const k = this.key(face, cx, cy);
    let c = this.chunks.get(k);
    if (c === undefined) {
      const list = chunkSolids(this.terrain, face, cx, cy);
      c = list.length ? new BreakableCollider<NatureSolid>(list) : null;
      this.chunks.set(k, c);
      this.solidCount += list.length;
      this.builtChunks++;
    }
    return c;
  }

  /** Has chunk (face, cx, cy) been built? */
  isBuilt(face: Face, cx: number, cy: number): boolean {
    return this.chunks.has(this.key(face, cx, cy));
  }

  /** The chunk key of a direction (any length), written into the reused key list if new. */
  private addKey(x: number, y: number, z: number) {
    const face = faceOf(x, y, z);
    faceUV(face, x, y, z, this.uv);
    const n = this.cpf;
    const cx = Math.min(n - 1, Math.max(0, Math.floor(((this.uv[0] + 1) / 2) * n)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(((this.uv[1] + 1) / 2) * n)));
    const k = this.key(face, cx, cy);
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === k) return;
    this.keys.push(k);
  }

  /** Fill `cols` with the (built) colliders of the chunks within `r` metres of (x, y, z); returns how many. */
  private gather(x: number, y: number, z: number, r: number, build = true): number {
    this.keys.length = 0;
    this.addKey(x, y, z);
    // Deep inside its chunk (the usual case: chunks are ~60–100 m wide), that chunk is all there is.
    // Face-plane coordinates stretch away from the face centre (du ≥ dθ), so r / R in angle is at
    // most r / R in u and v; twice that keeps clear of rounding.
    const n = this.cpf;
    const u = ((this.uv[0] + 1) / 2) * n, v = ((this.uv[1] + 1) / 2) * n;
    const edge = Math.min(u - Math.floor(u), Math.ceil(u) - u, v - Math.floor(v), Math.ceil(v) - v) * (2 / n);
    if (r > 0 && edge <= (2 * r) / this.terrain.body.radius) {
      const l = Math.hypot(x, y, z);
      const ux = x / l, uy = y / l, uz = z / l;
      const big = Math.abs(uz) < 0.9;
      const k = big ? uz : ux;
      let ax = (big ? 0 : 1) - k * ux, ay = -k * uy, az = (big ? 1 : 0) - k * uz;
      const al = Math.hypot(ax, ay, az);
      ax /= al; ay /= al; az /= al;
      const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
      for (let i = 0; i < 8; i++) {
        const c = COS8[i]! * r, s = SIN8[i]! * r;
        this.addKey(x + ax * c + bx * s, y + ay * c + by * s, z + az * c + bz * s);
      }
    }
    this.cols.length = 0;
    for (const k of this.keys) {
      const face = Math.floor(k / 65536) as Face;
      const cy = Math.floor((k % 65536) / 256), cx = k % 256;
      const c = build ? this.chunk(face, cx, cy) : (this.chunks.get(k) ?? null);
      if (c) this.cols.push(c);
    }
    return this.cols.length;
  }

  /**
   * Build up to `budget` not-yet-built chunks within `r` metres of (x, y, z) (warm-up ahead of the
   * player; a query would otherwise build them on the spot). Returns how many it built.
   */
  warm(x: number, y: number, z: number, r: number, budget = 1): number {
    this.keys.length = 0;
    this.addKey(x, y, z);
    const l = Math.hypot(x, y, z);
    const ux = x / l, uy = y / l, uz = z / l;
    const big = Math.abs(uz) < 0.9;
    const k0 = big ? uz : ux;
    let ax = (big ? 0 : 1) - k0 * ux, ay = -k0 * uy, az = (big ? 1 : 0) - k0 * uz;
    const al = Math.hypot(ax, ay, az);
    ax /= al; ay /= al; az /= al;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    for (const f of [0.5, 1]) {
      for (let i = 0; i < 8; i++) {
        const c = COS8[i]! * r * f, s = SIN8[i]! * r * f;
        this.addKey(x + ax * c + bx * s, y + ay * c + by * s, z + az * c + bz * s);
      }
    }
    let built = 0;
    for (const k of this.keys) {
      if (built >= budget) break;
      if (this.chunks.has(k)) continue;
      this.chunk(Math.floor(k / 65536) as Face, k % 256, Math.floor((k % 65536) / 256));
      built++;
    }
    return built;
  }

  /**
   * Push feet `p` out of the solids near it; fills `out` like BreakableCollider.resolve (push
   * direction, the floor of a top the feet stand on). Returns true if `p` moved.
   */
  resolve(p: XYZ, out: PropContact, body: SolidBody = PLAYER_BODY): boolean {
    resetContact(out);
    const n = this.gather(p.x, p.y, p.z, body.radius + MAX_SOLID_RADIUS);
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (!this.cols[i]!.resolve(p, always, this.contact, body)) {
        if (this.contact.floor > out.floor) out.floor = this.contact.floor;
        continue;
      }
      moved = true;
      if (this.contact.pushed) {
        out.pushed = true;
        out.nx = this.contact.nx;
        out.ny = this.contact.ny;
        out.nz = this.contact.nz;
      }
      if (this.contact.floor > out.floor) out.floor = this.contact.floor;
    }
    return moved;
  }

  /**
   * Distance along a ray (unit d) to the first solid at least `minRadius` wide within `maxT`, or
   * Infinity (the camera: CAMERA_SOLID_RADIUS keeps it off boulders and spires, not trunks).
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, minRadius = 0): number {
    const n = this.gather(ox + dx * maxT * 0.5, oy + dy * maxT * 0.5, oz + dz * maxT * 0.5, maxT * 0.5 + MAX_SOLID_RADIUS);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const c = this.cols[i]!;
      this.rayList = c.list;
      this.rayMin = minRadius;
      const t = c.raycast(ox, oy, oz, dx, dy, dz, Math.min(maxT, best), minRadius > 0 ? this.wideEnough : always);
      if (t < best) best = t;
    }
    return best;
  }

  /**
   * Movement footing at feet (x, y, z), like StructureCollider.footing: `top` = distance from the
   * planet centre of the highest top under the feet (0 = none); `inside` = deep in a solid. Reused object.
   */
  footing(x: number, y: number, z: number, step: number, body: SolidBody = PLAYER_BODY): { top: number; inside: boolean } {
    const out = this.footingOut;
    out.top = 0;
    out.inside = false;
    const n = this.gather(x, y, z, body.radius + MAX_SOLID_RADIUS);
    for (let i = 0; i < n; i++) {
      const c = this.cols[i]!;
      this.supportBody.radius = body.radius;
      this.supportBody.step = step;
      const top = supportHeightAt(c, x, y, z, always, this.supportBody);
      if (top > out.top) out.top = top;
      if (out.inside) continue;
      const m = c.grid.collect(x, y, z, 0, 0, 0, 0, body.radius + body.height, this.candidates);
      for (let k = 0; k < m && !out.inside; k++) {
        const p = this.scratch;
        p.x = x;
        p.y = y;
        p.z = z;
        if (!pushOutOfBreakable(c.list[this.candidates[k]!]!, p, body.radius, body.height, step, resetContact(this.contact))) continue;
        if (Math.hypot(p.x - x, p.y - y, p.z - z) >= body.radius + INSIDE_MARGIN) out.inside = true;
      }
    }
    return out;
  }

  /** Do feet moving straight from a to b pass through a solid (a start already inside one doesn't count)? */
  crosses(ax: number, ay: number, az: number, bx: number, by: number, bz: number, body: SolidBody = PLAYER_BODY): boolean {
    const half = Math.hypot(bx - ax, by - ay, bz - az) / 2;
    const n = this.gather((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, half + body.radius + MAX_SOLID_RADIUS);
    const a = this.a, b = this.b;
    for (let i = 0; i < n; i++) {
      a.x = ax; a.y = ay; a.z = az;
      b.x = bx; b.y = by; b.z = bz;
      if (this.cols[i]!.sweep(a, b, always, body) >= 0) return true;
    }
    return false;
  }

  /** Is any solid within `r` metres of (x, y, z) (its bounding sphere)? NPC steering follows obstacles there. */
  near(x: number, y: number, z: number, r: number): boolean {
    const n = this.gather(x, y, z, r + MAX_SOLID_RADIUS);
    for (let i = 0; i < n; i++) if (this.cols[i]!.grid.collect(x, y, z, 0, 0, 0, 0, r, this.candidates) > 0) return true;
    return false;
  }

  /** Nothing pushes feet at `p` and they aren't inside a solid (for `body`, default the player). */
  isClear(p: XYZ, body: SolidBody = PLAYER_BODY): boolean {
    const q = this.clearQ;
    q.x = p.x;
    q.y = p.y;
    q.z = p.z;
    const pushed = this.resolve(q, this.contact, body) && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) >= 1e-6;
    return !pushed && !this.footing(p.x, p.y, p.z, PLAYER_BODY.step, body).inside;
  }

  /**
   * Push feet `p` (on the ground) out of the solids the way the client's first frame would, re-snapped
   * to the ground by `groundR(dirX, dirY, dirZ)`; where that can't settle, the nearest clear spot on
   * rings round `p` (0.5 m apart, 24 bearings, out to 30 m). Writes `p`; false if nothing clear was found.
   */
  clearSpot(p: XYZ, groundR: (x: number, y: number, z: number) => number, who: SolidBody = PLAYER_BODY): boolean {
    const x0 = p.x, y0 = p.y, z0 = p.z;
    const body = { radius: who.radius + CLEAR_MARGIN, height: who.height, step: who.step };
    const snap = (q: XYZ) => {
      const l = Math.hypot(q.x, q.y, q.z);
      const r = groundR(q.x / l, q.y / l, q.z / l) / l;
      q.x *= r;
      q.y *= r;
      q.z *= r;
    };
    const c = emptyContact();
    for (let k = 0; k < 12; k++) {
      const px = p.x, py = p.y, pz = p.z;
      this.resolve(p, c, body);
      snap(p);
      if (Math.hypot(p.x - px, p.y - py, p.z - pz) < 1e-4) break;
    }
    if (this.isClear(p, who)) return true;
    const l0 = Math.hypot(x0, y0, z0);
    const ux = x0 / l0, uy = y0 / l0, uz = z0 / l0;
    const ref = Math.abs(uz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k0 = ref[0]! * ux + ref[1]! * uy + ref[2]! * uz;
    let ax = ref[0]! - k0 * ux, ay = ref[1]! - k0 * uy, az = ref[2]! - k0 * uz;
    const al = Math.hypot(ax, ay, az);
    ax /= al; ay /= al; az /= al;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    const q: XYZ = { x: 0, y: 0, z: 0 };
    for (let ring = 1; ring <= 60; ring++) {
      const d = ring * 0.5;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const cc = Math.cos(a) * d, sn = Math.sin(a) * d;
        q.x = x0 + ax * cc + bx * sn;
        q.y = y0 + ay * cc + by * sn;
        q.z = z0 + az * cc + bz * sn;
        snap(q);
        if (!this.isClear(q, body)) continue;
        p.x = q.x;
        p.y = q.y;
        p.z = q.z;
        return true;
      }
    }
    return false;
  }
}

const COS8 = Array.from({ length: 8 }, (_, i) => Math.cos((i / 8) * Math.PI * 2));
const SIN8 = Array.from({ length: 8 }, (_, i) => Math.sin((i / 8) * Math.PI * 2));

const byBody = new Map<BodyId, NatureSolids>();

/**
 * The natural solids of `terrain`'s body, shared by every room (and view) of that body: placement is
 * a pure function of the body, so one cache serves them all.
 */
export function natureSolids(terrain: Terrain): NatureSolids {
  let n = byBody.get(terrain.body.id);
  if (!n) {
    n = new NatureSolids(terrain);
    byBody.set(terrain.body.id, n);
  }
  return n;
}

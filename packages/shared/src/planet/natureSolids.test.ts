import { describe, expect, it } from "vitest";
import { BODIES, type BodyId } from "./bodies.ts";
import { emptyContact, PLAYER_BODY } from "./collide.ts";
import { faceOf, type Face } from "./cubesphere.ts";
import { NatureSolids } from "./natureSolids.ts";
import { padDirs } from "./pads.ts";
import { portalSpots } from "./portals.ts";
import { chunkProps, propSolid, SOLID_KINDS, solidChunkProps, type PropInstance } from "./props.ts";
import { createTerrain } from "./terrain.ts";

const BODY_IDS: BodyId[] = ["portus", "arcadia", "hollowmere", "meridian"];
const key = (p: PropInstance) => `${p.kind}:${p.x.toFixed(4)}:${p.y.toFixed(4)}:${p.z.toFixed(4)}:${p.scale.toFixed(4)}`;

/** A few chunks spread over the body (one per face, middle and edge). */
function sampleChunks(id: BodyId): [Face, number, number][] {
  const n = BODIES[id].chunksPerFace;
  const out: [Face, number, number][] = [];
  for (let f = 0; f < 6; f++) out.push([f as Face, Math.floor(n / 2), (f * 3) % n], [f as Face, 0, n - 1]);
  return out;
}

/** The first solid prop of a body that stands clear of others (for push and sweep checks). */
function loneSolid(solids: NatureSolids, id: BodyId, min = 0.2) {
  const t = solids.terrain;
  for (const [f, cx, cy] of sampleChunks(id)) {
    const list = solidChunkProps(t, f, cx, cy);
    for (const p of list) {
      const s = propSolid(p.kind, p.scale)!;
      if (s.radius < min) continue;
      if (list.some((q) => q !== p && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < s.radius + 4)) continue;
      return { p, s };
    }
  }
  throw new Error(`no lone solid on ${id}`);
}

describe("natural solids (D-solid-1)", () => {
  it.each(BODY_IDS)("%s: the solid props are exactly the drawn props that propSolid says block", (id) => {
    const t = createTerrain(id);
    for (const [f, cx, cy] of sampleChunks(id)) {
      const drawn = chunkProps(t, f, cx, cy).filter((p) => propSolid(p.kind, p.scale)).map(key);
      expect(solidChunkProps(t, f, cx, cy).map(key)).toEqual(drawn);
    }
  });

  it("walk-through kinds stay walk-through; small rocks too", () => {
    for (const k of ["bush", "reed", "scrub", "fern", "flower", "mushroom"] as const) expect(SOLID_KINDS.has(k)).toBe(false);
    expect(propSolid("rock", 0.7)).toBeNull();
    expect(propSolid("rock", 1)).not.toBeNull();
    expect(propSolid("oak", 0.8)!.radius).toBeCloseTo(0.28, 5);
  });

  it.each(BODY_IDS)("%s: a trunk or rock pushes a player out sideways, a straight walk through it is refused, a walk past it isn't", (id) => {
    const solids = new NatureSolids(createTerrain(id));
    const { p, s } = loneSolid(solids, id);
    const l = Math.hypot(p.x, p.y, p.z);
    const u = [p.x / l, p.y / l, p.z / l];
    // A tangent and the point 0.1 m off the centre along it.
    const ref = Math.abs(u[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0]! * u[0]! + ref[1]! * u[1]! + ref[2]! * u[2]!;
    const t = [ref[0]! - k * u[0]!, ref[1]! - k * u[1]!, ref[2]! - k * u[2]!];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    const at = (m: number) => ({ x: p.x + (t[0]! / tl) * m, y: p.y + (t[1]! / tl) * m, z: p.z + (t[2]! / tl) * m });
    const q = at(0.1);
    const c = emptyContact();
    expect(solids.resolve(q, c)).toBe(true);
    expect(c.pushed).toBe(true);
    expect(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)).toBeGreaterThanOrEqual(s.radius + PLAYER_BODY.radius - 0.01);
    expect(solids.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside).toBe(true);
    const a = at(-3), b = at(3);
    expect(solids.crosses(a.x, a.y, a.z, b.x, b.y, b.z)).toBe(true);
    // Beside it (its radius plus a body away, sideways): clear all the way.
    const side = [u[1]! * t[2]! - u[2]! * t[1]!, u[2]! * t[0]! - u[0]! * t[2]!, u[0]! * t[1]! - u[1]! * t[0]!].map((v) => v / tl);
    const off = s.radius + PLAYER_BODY.radius + 0.2;
    const a2 = { x: a.x + side[0]! * off, y: a.y + side[1]! * off, z: a.z + side[2]! * off };
    const b2 = { x: b.x + side[0]! * off, y: b.y + side[1]! * off, z: b.z + side[2]! * off };
    expect(solids.crosses(a2.x, a2.y, a2.z, b2.x, b2.y, b2.z)).toBe(false);
    expect(solids.isClear(at(s.radius + PLAYER_BODY.radius + 0.1))).toBe(true);
  });

  it.each(BODY_IDS)("%s: the arrival spots, the spawn ring and the portals are clear of solids", (id) => {
    const t = createTerrain(id);
    const solids = new NatureSolids(t);
    const R = BODIES[id].radius;
    const pads = padDirs(BODIES[id]);
    for (const d of pads) {
      for (let r = 0; r <= 8; r += 2) {
        for (let a = 0; a < 8; a++) {
          const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
          const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
          const t1 = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
          const t1l = Math.hypot(t1[0]!, t1[1]!, t1[2]!);
          const t2 = [d[1] * t1[2]! - d[2] * t1[1]!, d[2] * t1[0]! - d[0] * t1[2]!, d[0] * t1[1]! - d[1] * t1[0]!].map((v) => v / t1l);
          const ang = (a / 8) * Math.PI * 2;
          const v = [d[0] + ((t1[0]! / t1l) * Math.cos(ang) + t2[0]! * Math.sin(ang)) * (r / R), d[1] + ((t1[1]! / t1l) * Math.cos(ang) + t2[1]! * Math.sin(ang)) * (r / R), d[2] + ((t1[2]! / t1l) * Math.cos(ang) + t2[2]! * Math.sin(ang)) * (r / R)];
          const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
          const g = R + t.groundHeight(v[0]! / vl, v[1]! / vl, v[2]! / vl);
          expect(solids.isClear({ x: (v[0]! / vl) * g, y: (v[1]! / vl) * g, z: (v[2]! / vl) * g })).toBe(true);
        }
      }
    }
    for (const s of portalSpots(BODIES[id], t)) {
      const g = R + s.h;
      expect(solids.isClear({ x: s.dir[0] * g, y: s.dir[1] * g, z: s.dir[2] * g })).toBe(true);
    }
  });

  it("queries build only the chunks they touch, and answer the same after", () => {
    const t = createTerrain("arcadia");
    const solids = new NatureSolids(t);
    const { p } = loneSolid(new NatureSolids(t), "arcadia");
    expect(solids.builtChunks).toBe(0);
    const first = solids.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside;
    expect(solids.builtChunks).toBeGreaterThan(0);
    expect(solids.builtChunks).toBeLessThanOrEqual(4);
    const built = solids.builtChunks;
    expect(solids.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside).toBe(first);
    expect(solids.builtChunks).toBe(built);
    // warm() builds ahead within its budget.
    const l = Math.hypot(p.x, p.y, p.z);
    expect(solids.warm(p.x, p.y, p.z, 200, 2)).toBeLessThanOrEqual(2);
    expect(faceOf(p.x / l, p.y / l, p.z / l)).toBeGreaterThanOrEqual(0);
  });
});

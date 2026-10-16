import { describe, expect, it } from "vitest";
import { OUTPOSTS, WAYSTONE_AT, type OutpostBody } from "../content/padOutposts.ts";
import { objectPos, WORLD_OBJECTS } from "../content/world.ts";
import { BODIES } from "./bodies.ts";
import { bodyBreakables, type SolidFrame } from "./breakables.ts";
import { PLAYER_BODY, type XYZ } from "./collide.ts";
import { padDirs, PAD_SAFE_RADIUS } from "./pads.ts";
import { portalSpots } from "./portals.ts";
import {
  outpostAnchor, padPlatformPlacement, placeSiteItem, POLE_ANCHOR, siteAnchor, siteCoords, siteDir, sitePlacements, sitePrefabs, siteSolids, structureCollider,
  type StructureSolid,
} from "./sites.ts";
import { createTerrain, type Terrain } from "./terrain.ts";
import { townDir, townFrame, type TownPlacement } from "./townFrame.ts";

const PLANETS: OutpostBody[] = ["arcadia", "hollowmere", "meridian"];
const terrains = new Map<OutpostBody, Terrain>(PLANETS.map((b) => [b, createTerrain(b)]));
/** Jump apex (server movement.ts: 6.6² / (2 · 18)) + the step band of a top (collide.ts). */
const JUMP_REACH = (6.6 * 6.6) / (2 * 18) + PLAYER_BODY.step;

function empty(): TownPlacement {
  return { item: 0, prefab: 0, scale: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
}

/** A solid's ground footprint as a polygon in pad 0's site frame (east, north). */
function footprint(t: Terrain, s: SolidFrame, parts = true): [number, number][][] {
  const a = outpostAnchor(t);
  const R = t.body.radius;
  const polys: [number, number][][] = [];
  const shapes: [0 | 1, number, number][] = [[s.shape, s.hx, s.hz]];
  if (parts) for (const q of s.parts ?? []) shapes.push([q.shape, q.hx, q.hz]);
  for (const [shape, hx, hz] of shapes) {
    const pts: [number, number][] = [];
    const n = shape === 1 ? 16 : 4;
    for (let k = 0; k < n; k++) {
      let lx: number, lz: number;
      if (shape === 1) {
        lx = hx * Math.cos((2 * Math.PI * k) / n);
        lz = hx * Math.sin((2 * Math.PI * k) / n);
      } else {
        lx = (k === 0 || k === 3 ? -1 : 1) * hx;
        lz = (k < 2 ? -1 : 1) * hz;
      }
      pts.push(siteCoords(a, s.px + s.rx * lx + s.fx * lz, s.py + s.ry * lx + s.fy * lz, s.pz + s.rz * lx + s.fz * lz, R));
    }
    polys.push(pts);
  }
  return polys;
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function inside(p: [number, number], poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Gap (m) between two convex polygons (0 when they overlap). */
function gap(a: [number, number][], b: [number, number][]): number {
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return 0;
  let d = Infinity;
  for (const p of a) for (let i = 0; i < b.length; i++) d = Math.min(d, segDist(p, b[i]!, b[(i + 1) % b.length]!));
  for (const p of b) for (let i = 0; i < a.length; i++) d = Math.min(d, segDist(p, a[i]!, a[(i + 1) % a.length]!));
  return d;
}

/** Outpost (pad 0) solids: item >= 0. */
function outpostSolids(t: Terrain): StructureSolid[] {
  return siteSolids(t).filter((s) => s.item >= 0);
}

const radial = (s: SolidFrame) => Math.hypot(s.px, s.py, s.pz);

describe("structure sites: frames", () => {
  it("the pole anchor is the Portus town frame, exactly", () => {
    for (const [e, n, yaw] of [[0, 0, 0], [12.5, -7, 33], [-40, 61, -120]] as const) {
      expect(siteDir(POLE_ANCHOR, e, n, 150)).toEqual(townDir(e, n, 150));
      const p = placeSiteItem(POLE_ANCHOR, e, n, yaw, 150, 150, empty());
      const q = townFrame(e, n, yaw, 150, empty());
      for (const k of ["rx", "ry", "rz", "ux", "uy", "uz", "fx", "fy", "fz"] as const) expect(p[k] === q[k], k).toBe(true); // ±0 aside, identical
    }
    expect(siteAnchor([0, 1, 0])).toEqual(POLE_ANCHOR);
  });

  it("pad 0's frame puts the portal 8.5 m north of the pad and the guide at (4.5, -3), facing the pad", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const a = outpostAnchor(t);
      const spot = portalSpots(BODIES[b], t)[0]!;
      const pc = siteCoords(a, spot.dir[0], spot.dir[1], spot.dir[2], t.body.radius);
      expect(pc[0]).toBeCloseTo(0, 3);
      expect(pc[1]).toBeCloseTo(8.5, 2);
      const guide = WORLD_OBJECTS.find((o) => o.body === b && o.look === "guide")!;
      const g = objectPos(guide, t.groundHeight);
      const gc = siteCoords(a, g[0], g[1], g[2], t.body.radius);
      expect(gc[0]).toBeCloseTo(4.5, 1);
      expect(gc[1]).toBeCloseTo(-3, 1);
      // siteCoords inverts siteDir
      const d = siteDir(a, 17.25, -31.5, t.body.radius);
      const back = siteCoords(a, d[0], d[1], d[2], t.body.radius);
      expect(back[0]).toBeCloseTo(17.25, 6);
      expect(back[1]).toBeCloseTo(-31.5, 6);
    }
  });

  it("is deterministic and places every outpost item, a waystone at each other pad, on the shared prefabs", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const again = createTerrain(b);
      expect(siteSolids(again)).toEqual(siteSolids(t));
      const placed = sitePlacements(t);
      const pads = padDirs(BODIES[b]);
      expect(placed.length).toBe(OUTPOSTS[b].layout.length + pads.length - 1);
      const waystones = placed.filter((p) => p.item < 0);
      expect(waystones.map((p) => p.prefab)).toEqual(new Array(pads.length - 1).fill(OUTPOSTS[b].waystone));
      // One fixed offset from each pad's platform frame (the client instances platform + waystone).
      const rel = (w: TownPlacement) => {
        const p = padPlatformPlacement(t, -1 - w.item);
        const d = [w.px - p.px, w.py - p.py, w.pz - p.pz];
        const dot = (ax: number, ay: number, az: number, b: readonly number[]) => ax * b[0]! + ay * b[1]! + az * b[2]!;
        const axes = (q: TownPlacement) => [[q.rx, q.ry, q.rz], [q.ux, q.uy, q.uz], [q.fx, q.fy, q.fz]] as const;
        return [
          ...[dot(p.rx, p.ry, p.rz, d), dot(p.ux, p.uy, p.uz, d), dot(p.fx, p.fy, p.fz, d)],
          ...axes(w).flatMap((v) => axes(p).map((u) => dot(u[0], u[1], u[2], v))),
        ];
      };
      const first = rel(waystones[0]!);
      for (const w of waystones) {
        const k = -1 - w.item;
        rel(w).forEach((v, i) => expect(v).toBeCloseTo(first[i]!, 6));
        // Where WAYSTONE_AT puts it (the geodesic offset shrinks a little with the pad's height), on the ground.
        const c = siteCoords(siteAnchor(pads[k]!), w.px, w.py, w.pz, t.body.radius);
        expect(Math.hypot(c[0] - WAYSTONE_AT[0], c[1] - WAYSTONE_AT[1])).toBeLessThan(0.35);
        const l = Math.hypot(w.px, w.py, w.pz);
        expect(Math.abs(l - t.body.radius - t.groundHeight(w.px / l, w.py / l, w.pz / l))).toBeLessThan(0.1);
      }
      expect(sitePrefabs(b)).toBe(OUTPOSTS[b].prefabs);
    }
  });

  it("bases sit on the ground under each footprint (plinths take up the slope, docks may stand out over water)", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const R = t.body.radius;
      for (const p of sitePlacements(t)) {
        if (p.item < 0) continue;
        const g = t.groundHeight(p.ux, p.uy, p.uz);
        const base = Math.hypot(p.px, p.py, p.pz) - R;
        const pre = OUTPOSTS[b].prefabs[p.prefab]!;
        // The boats float on the water; the docks' land end is on the shore. The outpost wall's pieces
        // (round 2) stand on the highest ground under them, their foundations 4 m deep (design.py WALL_SKIRT).
        if (pre.name.endsWith("_skiff") || pre.name.endsWith("_rowboat")) continue;
        const ring = /_ring(wall|post|gate)$/.test(pre.name);
        expect(Math.abs(base - g), `${b} ${pre.name}`).toBeLessThan(ring ? 3.9 : pre.name.endsWith("_jetty") || pre.name.endsWith("_boardwalk") ? 1.6 : 1.2);
        if (ring) for (const sol of pre.solids) expect(sol[5], `${b} ${pre.name} foundation`).toBeLessThanOrEqual(-4);
      }
    }
  });
});

describe("structure sites: the outposts keep clear of everything authoritative", () => {
  it("leaves a walkable gap (>= 1.2 m) to every pinned breakable", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const brk = bodyBreakables(t).filter((x) => Math.hypot(...siteCoords(outpostAnchor(t), x.px, x.py, x.pz, t.body.radius)) < 80);
      expect(brk.length).toBeGreaterThan(5);
      let min = Infinity;
      for (const s of siteSolids(t)) {
        const fs = footprint(t, s);
        for (const x of brk) {
          if (Math.hypot(s.px - x.px, s.py - x.py, s.pz - x.pz) > 30) continue;
          for (const fa of fs) for (const fb of footprint(t, x)) min = Math.min(min, gap(fa, fb));
        }
      }
      expect(min, b).toBeGreaterThanOrEqual(1.2);
    }
  });

  it("keeps the pad, the spawn ring, the fast-travel ring, the guide and the walk into the portal clear", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const R = t.body.radius;
      const a = outpostAnchor(t);
      const c = structureCollider(t);
      const feet = (e: number, n: number): XYZ => {
        const d = siteDir(a, e, n, R);
        const r = R + t.groundHeight(d[0], d[1], d[2]);
        return { x: d[0] * r, y: d[1] * r, z: d[2] * r };
      };
      // Nothing on the pad or its apron but the gate's posts (outside the ring's walk-in path).
      const gate = OUTPOSTS[b].prefabs.findIndex((p) => p.name.endsWith("_gate"));
      for (const s of outpostSolids(t)) {
        if (s.prefab === gate) continue;
        for (const f of footprint(t, s)) for (const q of f) expect(Math.hypot(q[0], q[1]), `${b} prefab ${s.prefab}`).toBeGreaterThan(9.2);
      }
      for (let k = 0; k < 24; k++) {
        const ang = (k / 24) * Math.PI * 2;
        for (const r of [2, 3.5, 6, 8]) {
          // The gate stands on the platform's north edge round the portal (8.5 m north): Meridian's
          // gate A (round 2) has its pylons 2.35 m either side of it, reaching in to 7.65 m.
          const e = Math.cos(ang) * r, n = Math.sin(ang) * r;
          if (r === 8 && Math.hypot(e, n - 8.5) < 4.2) continue;
          expect(c.isClear(feet(e, n)), `${b} r ${r}`).toBe(true);
        }
      }
      expect(c.isClear(feet(4.5, -3))).toBe(true);
      // Walk from the spawn into the ring's disc (8.5 m north): no structure crossed.
      for (const e of [-1.5, 0, 1.5]) {
        const p0 = feet(e, -4), p1 = feet(e, 8.4);
        expect(c.crosses(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z), `${b} lane ${e}`).toBe(false);
      }
      // The other pads: fast-travel arrivals (3.5 m ring) and the whole platform are clear of the waystone.
      const pads = padDirs(BODIES[b]);
      for (let k = 1; k < pads.length; k++) {
        const pa = siteAnchor(pads[k]!);
        for (let i = 0; i < 12; i++) {
          const ang = (i / 12) * Math.PI * 2;
          for (const r of [3.5, 8]) {
            const d = siteDir(pa, Math.cos(ang) * r, Math.sin(ang) * r, R);
            const g = R + t.groundHeight(d[0], d[1], d[2]);
            expect(c.isClear({ x: d[0] * g, y: d[1] * g, z: d[2] * g })).toBe(true);
          }
        }
      }
    }
  });

  it("puts everything within the 12-45 m band round pad 0 or inside the safe ring's edge, nothing beyond 50 m", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const a = outpostAnchor(t);
      for (const s of outpostSolids(t)) {
        const c = siteCoords(a, s.px, s.py, s.pz, t.body.radius);
        expect(Math.hypot(c[0], c[1]), b).toBeLessThan(50);
      }
      expect(PAD_SAFE_RADIUS).toBe(12);
    }
  });

  it("stops a ray that starts inside a structure at once (the Portus town's walls and an outpost's barn alike)", () => {
    const cases: [Terrain, (x: StructureSolid) => boolean][] = [
      [createTerrain("portus"), (x) => x.shape === 0 && x.hx > 3 && x.h > 6], // a curtain wall run
      [terrains.get("arcadia")!, (x) => x.item === OUTPOSTS.arcadia.layout.findIndex((it) => OUTPOSTS.arcadia.prefabs[it[0]]!.name === "a_barn")],
    ];
    for (const [t, pick] of cases) {
      const c = structureCollider(t);
      const s = c.solids.find(pick)!;
      expect(s, t.body.id).toBeDefined();
      // Just inside the solid's front face, at chest height, looking out through the face and on.
      const k = s.hz - 0.025, h = Math.min(1.5, s.h / 2) + 1.5;
      const o = [s.px + s.fx * k + s.ux * h, s.py + s.fy * k + s.uy * h, s.pz + s.fz * k + s.uz * h] as const;
      for (const dir of [[s.fx, s.fy, s.fz], [-s.fx, -s.fy, -s.fz], [s.rx, s.ry, s.rz]] as const) {
        expect(c.raycast(o[0], o[1], o[2], dir[0], dir[1], dir[2], 30), t.body.id).toBe(0);
      }
      const far = [o[0] + s.fx * 10, o[1] + s.fy * 10, o[2] + s.fz * 10] as const;
      expect(c.blocks(o[0], o[1], o[2], far[0], far[1], far[2]), t.body.id).toBe(true);
      expect(c.blocks(far[0], far[1], far[2], o[0], o[1], o[2]), t.body.id).toBe(true);
    }
  });

  it("leaves no perch: no top a player can jump onto stands more than 1.6 m over the ground (breakables count as steps)", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const R = t.body.radius;
      interface Top { label: string; poly: [number, number][]; top: number; ground: number; structure: boolean }
      const tops: Top[] = [];
      const near = (x: SolidFrame) => Math.hypot(...siteCoords(outpostAnchor(t), x.px, x.py, x.pz, R)) < 60;
      for (const s of outpostSolids(t)) {
        const f = footprint(t, s)[0]!;
        const g = Math.min(...f.map((q) => { const d = siteDir(outpostAnchor(t), q[0], q[1], R); return t.groundHeight(d[0], d[1], d[2]); }));
        tops.push({ label: `prefab ${OUTPOSTS[b].prefabs[s.prefab]!.name}`, poly: f, top: radial(s) - R + s.h, ground: g, structure: true });
      }
      for (const x of bodyBreakables(t).filter(near)) tops.push({ label: x.id, poly: footprint(t, x, false)[0]!, top: radial(x) - R + x.h, ground: radial(x) - R, structure: false });
      const reach = tops.map((u) => u.top - u.ground <= JUMP_REACH);
      for (let changed = true; changed; ) {
        changed = false;
        tops.forEach((u, i) => {
          if (reach[i]) return;
          if (tops.some((v, j) => reach[j] && v !== u && gap(u.poly, v.poly) < 3.5 && u.top - v.top <= JUMP_REACH)) {
            reach[i] = true;
            changed = true;
          }
        });
      }
      // Inside the outpost wall (D-b2-1) nobody fights, so a perch there can't keep a player out of an
      // NPC's reach (design.py validate notes them); the wall itself, on the zone's edge, still counts.
      const inWall = (u: Top) => Math.hypot(u.poly.reduce((a, q) => a + q[0], 0) / u.poly.length, u.poly.reduce((a, q) => a + q[1], 0) / u.poly.length) < OUTPOSTS[b].wall.radius - 1.5;
      const perches = tops.filter((u, i) => reach[i] && u.structure && u.top - u.ground > 1.6 && !inWall(u)).map((u) => `${u.label} ${(u.top - u.ground).toFixed(2)} m`);
      expect(perches, b).toEqual([]);
    }
  });

  it("leaves walkable lanes between buildings: solids of different items touch or stand >= 1 m apart", () => {
    for (const b of PLANETS) {
      const t = terrains.get(b)!;
      const sol = outpostSolids(t).map((s) => ({ s, f: footprint(t, s)[0]! }));
      for (let i = 0; i < sol.length; i++) {
        for (let j = i + 1; j < sol.length; j++) {
          if (sol[i]!.s.item === sol[j]!.s.item) continue;
          const g = gap(sol[i]!.f, sol[j]!.f);
          expect(g === 0 || g >= 1.0, `${b}: items ${sol[i]!.s.item} / ${sol[j]!.s.item} ${g.toFixed(2)} m`).toBe(true);
        }
      }
    }
  });

  it("stops rays at walls: a shot through the barn, the chapel and Waystation Nine hits them", () => {
    const cases: [OutpostBody, string][] = [["arcadia", "a_barn"], ["hollowmere", "h_chapel"], ["meridian", "m_waystation"]];
    for (const [b, name] of cases) {
      const t = terrains.get(b)!;
      const pi = OUTPOSTS[b].prefabs.findIndex((p) => p.name === name);
      const p = sitePlacements(t).find((x) => x.prefab === pi && x.item >= 0)!;
      // From 14 m in front of it, aimed at its centre 1.5 m up.
      const tx = p.px + p.ux * 1.5, ty = p.py + p.uy * 1.5, tz = p.pz + p.uz * 1.5;
      const ox = tx + p.fx * 14, oy = ty + p.fy * 14, oz = tz + p.fz * 14;
      const dx = tx - ox, dy = ty - oy, dz = tz - oz, l = Math.hypot(dx, dy, dz);
      const hit = structureCollider(t).raycast(ox, oy, oz, dx / l, dy / l, dz / l, l);
      expect(hit, name).toBeLessThan(l);
      expect(structureCollider(t).blocks(ox, oy, oz, tx, ty, tz)).toBe(true);
    }
  });
});

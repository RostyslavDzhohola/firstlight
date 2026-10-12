import { describe, expect, it } from "vitest";
import { mulberry32 } from "../rng.ts";
import { BODIES, BODY_IDS, PLANET_IDS, type BodyId } from "./bodies.ts";
import {
  archetypeDef, bodyBreakables, BREAKABLE_ARCHETYPES, BREAKABLE_ARENA_MARGIN, BREAKABLE_MIN_DRY, BREAKABLE_SAFE_MARGIN, BreakableGrid,
  breakablePlacementReport, breakableSites, canBreak, distanceToBreakable, placeBreakables, rayBreakable,
  segmentNearBreakable, type Breakable,
} from "./breakables.ts";
import { chunkOf } from "./cubesphere.ts";
import { chordMetres, padDirs, PAD_SAFE_RADIUS } from "./pads.ts";
import { chunkProps, PROP_DEFS } from "./props.ts";
import { createTerrain, type Terrain } from "./terrain.ts";
import { bossArena } from "../content/arenas.ts";

const terrains = Object.fromEntries(BODY_IDS.map((id) => [id, createTerrain(id)])) as Record<BodyId, Terrain>;

/** Ground height under a local footprint point (x right, z forward) of a breakable. */
function groundAt(t: Terrain, b: Breakable, lx: number, lz: number): number {
  const R = t.body.radius;
  const dl = Math.hypot(b.px, b.py, b.pz);
  const x = (b.px / dl) * R + b.rx * lx + b.fx * lz;
  const y = (b.py / dl) * R + b.ry * lx + b.fy * lz;
  const z = (b.pz / dl) * R + b.rz * lx + b.fz * lz;
  const l = Math.hypot(x, y, z);
  return t.groundHeight(x / l, y / l, z / l);
}

describe("breakable placement", () => {
  it("is deterministic: a fresh terrain gives the same list as the cached one", { timeout: 60_000 }, () => {
    for (const id of PLANET_IDS) {
      const a = placeBreakables(createTerrain(id));
      expect(bodyBreakables(terrains[id])).toEqual(a);
      expect(a.length).toBeGreaterThan(120);
    }
  });

  it("Portus has none (its buildings never break)", () => {
    expect(bodyBreakables(terrains.portus)).toEqual([]);
    expect(breakableSites(BODIES.portus)).toEqual([]);
  });

  it("ids are unique, stable `${site}.${slot}`, and index is the list position", () => {
    for (const id of PLANET_IDS) {
      const list = bodyBreakables(terrains[id]);
      const sites = breakableSites(BODIES[id]);
      const ids = new Set<string>();
      list.forEach((b, i) => {
        expect(b.index).toBe(i);
        expect(b.id).toMatch(/^\d+\.\d+$/);
        expect(Number(b.id.split(".")[0])).toBe(b.site);
        expect(b.site).toBeLessThan(sites.length);
        expect(BREAKABLE_ARCHETYPES[b.archetype]).toBe(b.kind);
        ids.add(b.id);
      });
      expect(ids.size).toBe(list.length);
    }
  });

  it("sits on dry ground: no footprint corner floats, and slopes stay within the archetype's step", { timeout: 60_000 }, () => {
    for (const id of PLANET_IDS) {
      const t = terrains[id];
      const R = t.body.radius;
      for (const b of bodyBreakables(t)) {
        const baseH = Math.hypot(b.px, b.py, b.pz) - R;
        expect(baseH).toBeGreaterThan(t.body.waterLevel + BREAKABLE_MIN_DRY - 0.1);
        const def = archetypeDef(id, b.kind);
        const corners = b.shape === 0
          ? [[b.hx, b.hz], [-b.hx, b.hz], [b.hx, -b.hz], [-b.hx, -b.hz], [0, 0]]
          : [[b.hx * 0.7071, b.hx * 0.7071], [-b.hx * 0.7071, b.hx * 0.7071], [b.hx * 0.7071, -b.hx * 0.7071], [-b.hx * 0.7071, -b.hx * 0.7071], [0, 0]];
        let gmax = -Infinity;
        for (const [lx, lz] of corners) {
          const g = groundAt(t, b, lx!, lz!);
          // The base is at (or just under) the lowest ground point: nothing floats.
          expect(g).toBeGreaterThanOrEqual(baseH - 1e-6);
          gmax = Math.max(gmax, g);
        }
        expect(gmax - baseH).toBeLessThanOrEqual(def.maxStep * Math.max(1, b.scale) + 0.07);
        // Up is the radial direction; the frame is orthonormal.
        const l = Math.hypot(b.px, b.py, b.pz);
        expect(b.ux * b.px / l + b.uy * b.py / l + b.uz * b.pz / l).toBeCloseTo(1, 9);
        expect(b.rx * b.ux + b.ry * b.uy + b.rz * b.uz).toBeCloseTo(0, 9);
        expect(b.fx * b.ux + b.fy * b.uy + b.fz * b.uz).toBeCloseTo(0, 9);
        expect(b.fx * b.rx + b.fy * b.ry + b.fz * b.rz).toBeCloseTo(0, 9);
      }
    }
  });

  it("stays outside every pad's 12 m safe ring", () => {
    for (const id of PLANET_IDS) {
      const pads = padDirs(BODIES[id]);
      for (const b of bodyBreakables(terrains[id])) {
        const l = Math.hypot(b.px, b.py, b.pz);
        for (const p of pads) {
          expect(chordMetres(p, b.px / l, b.py / l, b.pz / l, BODIES[id].radius)).toBeGreaterThanOrEqual(PAD_SAFE_RADIUS + b.foot + BREAKABLE_SAFE_MARGIN - 1e-6);
        }
      }
    }
  });

  it("doesn't overlap trees, rocks or spires", { timeout: 60_000 }, () => {
    for (const id of PLANET_IDS) {
      const t = terrains[id];
      const cache = new Map<string, ReturnType<typeof chunkProps>>();
      for (const b of bodyBreakables(t)) {
        const l = Math.hypot(b.px, b.py, b.pz);
        const k = chunkOf(b.px / l, b.py / l, b.pz / l, t.body.chunksPerFace);
        const key = `${k.face}:${k.cx}:${k.cy}`;
        if (!cache.has(key)) cache.set(key, chunkProps(t, k.face, k.cx, k.cy));
        for (const p of cache.get(key)!) {
          if (PROP_DEFS[p.kind].collider === "none") continue;
          const dx = p.x - b.px, dy = p.y - b.py, dz = p.z - b.pz;
          const up = (dx * b.px + dy * b.py + dz * b.pz) / l;
          const horiz = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - up * up));
          expect(horiz).toBeGreaterThanOrEqual(PROP_DEFS[p.kind].radius * p.scale + b.foot);
        }
      }
    }
  });

  it("every planet has every archetype; nothing sits in a boss arena (the NPC lane owns arena cover)", () => {
    for (const id of PLANET_IDS) {
      const kinds = new Set(bodyBreakables(terrains[id]).map((b) => b.kind));
      for (const a of BREAKABLE_ARCHETYPES) expect(kinds, `${id} ${a}`).toContain(a);
      const arena = bossArena(terrains[id])!;
      expect(arena).toBeTruthy();
      for (const b of bodyBreakables(terrains[id])) {
        const l = Math.hypot(b.px, b.py, b.pz);
        expect(chordMetres(arena.up, b.px / l, b.py / l, b.pz / l, BODIES[id].radius)).toBeGreaterThanOrEqual(arena.radius + BREAKABLE_ARENA_MARGIN + b.foot - 1e-6);
      }
    }
    // Heavy cover is tougher per planet (content.md §4 numbers).
    expect(archetypeDef("arcadia", "cover").hp).toBe(400);
    expect(archetypeDef("hollowmere", "cover").hp).toBe(600);
    expect(archetypeDef("meridian", "cover").hp).toBe(900);
  });

  it("points of interest keep most of their props", { timeout: 60_000 }, () => {
    for (const id of PLANET_IDS) {
      for (const r of breakablePlacementReport(terrains[id])) {
        if (r.site.startsWith("pad ")) continue;
        const total = r.kept + r.water + r.steep + r.safe + r.arena + r.props + r.overlap;
        expect(r.kept / total, `${id} ${r.site}`).toBeGreaterThan(0.55);
      }
    }
  });

  it("destruction classes: light breaks crates, barrels and fences; heavy breaks everything; none breaks nothing", () => {
    for (const a of BREAKABLE_ARCHETYPES) {
      const size = archetypeDef("arcadia", a).size;
      expect(canBreak(size, "heavy")).toBe(true);
      expect(canBreak(size, "none")).toBe(false);
      expect(canBreak(size, "light")).toBe(a === "crate" || a === "barrel" || a === "fence");
    }
  });
});

describe("breakable hit tests", () => {
  const list = bodyBreakables(terrains.arcadia);
  const box = list.find((b) => b.shape === 0 && b.kind === "crate")!;
  const cyl = list.find((b) => b.shape === 1 && b.kind === "barrel")!;

  /** A world point from local coordinates (x right, y up from the base, z forward). */
  const at = (b: Breakable, x: number, y: number, z: number): [number, number, number] => [
    b.px + b.rx * x + b.ux * y + b.fx * z, b.py + b.ry * x + b.uy * y + b.fy * z, b.pz + b.rz * x + b.uz * y + b.fz * z,
  ];

  it("rays hit boxes and cylinders at the right distance, miss above them, and start inside at 0", () => {
    for (const b of [box, cyl]) {
      const o = at(b, 0, b.h / 2, -(b.hz + 5)); // 5 m in front, along +forward
      const t = rayBreakable(b, o[0], o[1], o[2], b.fx, b.fy, b.fz, 50);
      expect(t).toBeCloseTo(5, 6);
      expect(rayBreakable(b, o[0], o[1], o[2], b.fx, b.fy, b.fz, 4.9)).toBe(Infinity);
      const over = at(b, 0, b.h + 0.05, -(b.hz + 5));
      expect(rayBreakable(b, over[0], over[1], over[2], b.fx, b.fy, b.fz, 50)).toBe(Infinity);
      const inside = at(b, 0, b.h / 2, 0);
      expect(rayBreakable(b, inside[0], inside[1], inside[2], b.rx, b.ry, b.rz, 10)).toBe(0);
      // From the side: x extent (half width for a box, radius for a cylinder).
      const side = at(b, -(b.hx + 3), b.h * 0.3, 0);
      expect(rayBreakable(b, side[0], side[1], side[2], b.rx, b.ry, b.rz, 50)).toBeCloseTo(3, 6);
      // Downward onto the top face.
      const top = at(b, 0, b.h + 2, 0);
      expect(rayBreakable(b, top[0], top[1], top[2], -b.ux, -b.uy, -b.uz, 50)).toBeCloseTo(2, 6);
    }
    // A cylinder corner ray misses where a box would hit.
    const o = at(cyl, cyl.hx * 0.95, cyl.h / 2, -(cyl.hx + 4));
    const d = [cyl.fx, cyl.fy, cyl.fz] as const;
    expect(rayBreakable(cyl, o[0] + cyl.rx * 0.1, o[1] + cyl.ry * 0.1, o[2] + cyl.rz * 0.1, d[0], d[1], d[2], 50)).toBe(Infinity);
  });

  it("distance to a collider is 0 inside and the gap outside", () => {
    for (const b of [box, cyl]) {
      const inside = at(b, 0, b.h / 2, 0);
      expect(distanceToBreakable(b, inside[0], inside[1], inside[2])).toBe(0);
      const p = at(b, b.hx + 2, b.h / 2, 0);
      expect(distanceToBreakable(b, p[0], p[1], p[2])).toBeCloseTo(2, 6);
      const above = at(b, 0, b.h + 1.5, 0);
      expect(distanceToBreakable(b, above[0], above[1], above[2])).toBeCloseTo(1.5, 6);
    }
  });

  it("the grid returns every breakable a segment passes near (vs brute force)", () => {
    const grid = new BreakableGrid(list);
    const rand = mulberry32(5);
    const out: number[] = [];
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      const b = list[Math.floor(rand() * list.length)]!;
      const o: [number, number, number] = [b.cx + (rand() - 0.5) * 60, b.cy + (rand() - 0.5) * 60, b.cz + (rand() - 0.5) * 60];
      let d = [b.cx - o[0] + (rand() - 0.5) * 2, b.cy - o[1] + (rand() - 0.5) * 2, b.cz - o[2] + (rand() - 0.5) * 2];
      const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
      d = d.map((v) => v / dl);
      const maxT = 20 + rand() * 100;
      grid.collect(o[0], o[1], o[2], d[0]!, d[1]!, d[2]!, maxT, 0, out);
      const set = new Set(out);
      for (const c of list) {
        if (segmentNearBreakable(c, o[0], o[1], o[2], d[0]!, d[1]!, d[2]!, maxT)) {
          expect(set.has(c.index)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

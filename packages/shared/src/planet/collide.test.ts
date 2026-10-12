import { describe, expect, it } from "vitest";
import { bodyBreakables, distanceToBreakable, type Breakable } from "./breakables.ts";
import { BreakableCollider, emptyContact, PLAYER_BODY, pushOutOfBreakable, supportHeightAt, type XYZ } from "./collide.ts";
import { createTerrain } from "./terrain.ts";

const R = 500;

/** A prop standing at the north pole (up +y, right +x, forward +z), base on the sphere. */
function prop(over: Partial<Breakable> & Pick<Breakable, "shape" | "hx" | "hz" | "h">, index = 0): Breakable {
  const b = {
    id: `0.${index}`, index, site: 0, archetype: 0, kind: "crate",
    px: 0, py: R, pz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1,
    scale: 1, hp: 40, size: "light", rebuildMs: 1000,
    cx: 0, cy: 0, cz: 0, bound: 0, foot: 0,
    ...over,
  } as Breakable;
  b.cx = b.px + b.ux * b.h / 2;
  b.cy = b.py + b.uy * b.h / 2;
  b.cz = b.pz + b.uz * b.h / 2;
  b.foot = Math.max(b.shape === 0 ? Math.hypot(b.hx, b.hz) : b.hx, ...(b.parts ?? []).map((q) => (q.shape === 0 ? Math.hypot(q.hx, q.hz) : q.hx)));
  b.bound = Math.hypot(b.foot, b.h / 2);
  return b;
}

/** Feet at local (x, y, z) of the pole frame. */
const feet = (x: number, y: number, z: number): XYZ => ({ x, y: R + y, z });

const crate = prop({ shape: 0, hx: 0.5, hz: 0.5, h: 1 });
const barrel = prop({ shape: 1, hx: 0.42, hz: 0.42, h: 1.12, kind: "barrel" });
const { radius: r, height: H, step } = PLAYER_BODY;

describe("player vs one breakable", () => {
  it("leaves a player clear of the prop alone", () => {
    const p = feet(2, 0, 0);
    const c = emptyContact();
    expect(pushOutOfBreakable(crate, p, r, H, step, c)).toBe(false);
    expect(p).toEqual(feet(2, 0, 0));
    expect(c.pushed).toBe(false);
    expect(c.floor).toBe(0);
  });

  it("pushes a player overlapping a box face straight out, to exactly its radius", () => {
    const p = feet(0.6, 0, 0.1); // 0.1 m from the +x face, inside the radius
    const c = emptyContact();
    expect(pushOutOfBreakable(crate, p, r, H, step, c)).toBe(true);
    expect(p.x).toBeCloseTo(0.5 + r, 9);
    expect(p.y).toBeCloseTo(R, 9);
    expect(p.z).toBeCloseTo(0.1, 9);
    expect([c.nx, c.ny, c.nz]).toEqual([1, 0, 0]);
    expect(c.pushed).toBe(true);
  });

  it("pushes out of a box corner along the diagonal", () => {
    const p = feet(0.6, 0, 0.6);
    const c = emptyContact();
    pushOutOfBreakable(crate, p, r, H, step, c);
    expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeCloseTo(r, 9);
    expect(c.nx).toBeCloseTo(Math.SQRT1_2, 9);
    expect(c.nz).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("gets a player whose centre ended up inside a box out by the nearest face", () => {
    const p = feet(0.1, 0.2, -0.45); // nearest face is -z (0.05 away)
    pushOutOfBreakable(crate, p, r, H, step, emptyContact());
    expect(p.z).toBeCloseTo(-0.5 - r, 9);
    expect(p.x).toBeCloseTo(0.1, 9);
  });

  it("pushes radially out of a cylinder, and out of its exact centre too", () => {
    const p = feet(0.3, 0, 0.4); // 0.5 from the axis
    pushOutOfBreakable(barrel, p, r, H, step, emptyContact());
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(0.42 + r, 9);
    expect(p.x / p.z).toBeCloseTo(0.75, 9);
    const q = feet(0, 0, 0);
    pushOutOfBreakable(barrel, q, r, H, step, emptyContact());
    expect(Math.hypot(q.x, q.z)).toBeCloseTo(0.42 + r, 9);
  });

  it("ignores a player above the top, and treats feet near the top as standing on it", () => {
    const over = feet(0, 1.2, 0);
    const c = emptyContact();
    expect(pushOutOfBreakable(crate, over, r, H, step, c)).toBe(false);
    expect(c.floor).toBe(0);
    const landing = feet(0.2, 0.85, 0.1); // 15 cm into the top: lands on it, no shove
    expect(pushOutOfBreakable(crate, landing, r, H, step, c)).toBe(false);
    expect(landing).toEqual(feet(0.2, 0.85, 0.1));
    expect(c.floor).toBeCloseTo(Math.hypot(0.2, R + 1, 0.1), 9);
  });

  it("shoves a player off the top edge when their centre isn't over the footprint", () => {
    const p = feet(0.75, 0.9, 0); // feet near the top but hanging 0.25 m past the edge
    const c = emptyContact();
    expect(pushOutOfBreakable(crate, p, r, H, step, c)).toBe(true);
    expect(p.x).toBeCloseTo(0.5 + r, 9);
    expect(c.floor).toBe(0);
  });

  it("blocks a player whose head is under a tall prop's base too (any vertical overlap)", () => {
    const tall = prop({ shape: 1, hx: 0.5, hz: 0.5, h: 4.2 });
    const p = feet(0.6, 2, 0); // mid-jump beside a pillar
    expect(pushOutOfBreakable(tall, p, r, H, step, emptyContact())).toBe(true);
    expect(p.x).toBeCloseTo(0.5 + r, 9);
  });
});

describe("BreakableCollider (many props)", () => {
  const a = prop({ shape: 0, hx: 0.5, hz: 0.5, h: 1 }, 0);
  const b = prop({ shape: 0, hx: 0.5, hz: 0.5, h: 1, px: 1.0 + 2 * r - 0.1 }, 1); // a gap narrower than the player
  const collider = new BreakableCollider([a, b]);

  it("skips broken props", () => {
    const p = feet(0, 0, 0.6);
    const c = emptyContact();
    collider.resolve(p, () => false, c);
    expect(c.pushed).toBe(false);
    expect(p).toEqual(feet(0, 0, 0.6));
  });

  it("won't let a player walk through a gap narrower than their body", () => {
    const p = feet((a.px + b.px) / 2, 0, 2);
    const c = emptyContact();
    for (let k = 0; k < 80; k++) {
      p.z -= 0.05; // walking toward -z through the gap
      collider.resolve(p, () => true, c);
      for (const x of [a, b]) expect(distanceToBreakable(x, p.x, p.y + 0.5, p.z)).toBeGreaterThan(r - 0.005); // sub-mm residue at a two-corner squeeze
    }
    expect(p.z).toBeGreaterThan(0.5);
  });

  it("keeps the highest floor under the feet", () => {
    const low = prop({ shape: 0, hx: 2, hz: 2, h: 0.8 }, 0);
    const high = prop({ shape: 0, hx: 1, hz: 1, h: 1.0 }, 1);
    const both = new BreakableCollider([low, high]);
    const p = feet(0, 0.75, 0);
    const c = emptyContact();
    both.resolve(p, () => true, c);
    expect(c.floor).toBeCloseTo(R + 1, 6);
  });
});

describe("BreakableCollider.raycast", () => {
  const a = prop({ shape: 0, hx: 0.5, hz: 0.5, h: 1 }, 0);
  const b = prop({ shape: 1, hx: 0.4, hz: 0.4, h: 2, pz: 4 }, 1);
  const collider = new BreakableCollider([a, b]);

  it("finds the first solid prop along a ray, skipping broken ones and stopping at maxT", () => {
    const o = feet(0, 0.5, -3); // in front of the crate, looking +z through both props
    expect(collider.raycast(o.x, o.y, o.z, 0, 0, 1, 50, () => true)).toBeCloseTo(2.5, 9);
    expect(collider.raycast(o.x, o.y, o.z, 0, 0, 1, 50, (i) => i !== 0)).toBeCloseTo(6.6, 9);
    expect(collider.raycast(o.x, o.y, o.z, 0, 0, 1, 2, () => true)).toBe(Infinity);
    expect(collider.raycast(o.x, R + 3, o.z, 0, 0, 1, 50, () => true)).toBe(Infinity); // over both
  });
});

describe("compound colliders (statue base, pillar caps)", () => {
  // A statue: a 0.4 m figure cylinder on a 0.9 m square base, 0.5 m tall.
  const statue = prop({ shape: 1, hx: 0.4, hz: 0.4, h: 2.75, parts: [{ shape: 0, hx: 0.45, hz: 0.45, y0: 0, y1: 0.5 }] });
  const collider = new BreakableCollider([statue]);

  it("stops a downward shot on the base's corner, outside the figure", () => {
    const o = feet(0.36, 3, 0.36);
    expect(collider.raycast(o.x, o.y, o.z, 0, -1, 0, 10, () => true)).toBeCloseTo(2.5, 9);
    const past = feet(0.5, 3, 0.5); // beyond the base
    expect(collider.raycast(past.x, past.y, past.z, 0, -1, 0, 10, () => true)).toBe(Infinity);
    expect(distanceToBreakable(statue, 0.36, R + 0.6, 0.36)).toBeCloseTo(0.1, 9); // above the base top
  });

  it("pushes a player out of the base corner as well as the figure", () => {
    const p = feet(0.6, 0, 0.6); // 0.15 m from the base corner diagonally
    pushOutOfBreakable(statue, p, r, H, step, emptyContact());
    expect(distanceToBreakable(statue, p.x, p.y + 0.2, p.z)).toBeCloseTo(r, 6);
  });
});

describe("supportHeightAt (server movement validation)", () => {
  const crateA = prop({ shape: 0, hx: 0.5, hz: 0.5, h: 1 }, 0);
  const pillar = prop({ shape: 1, hx: 0.38, hz: 0.38, h: 4.2, px: 5, parts: [{ shape: 0, hx: 0.42, hz: 0.42, y0: 0, y1: 0.3 }, { shape: 0, hx: 0.42, hz: 0.42, y0: 3.9, y1: 4.2 }] }, 1);
  const props = new BreakableCollider([crateA, pillar]);

  it("is the crate top under feet standing on it or jumping above it", () => {
    expect(supportHeightAt(props, 0.2, R + 1, 0.1)).toBeCloseTo(Math.hypot(0.2, R + 1, 0.1), 9);
    expect(supportHeightAt(props, 0.2, R + 2.2, 0.1)).toBeCloseTo(Math.hypot(0.2, R + 1, 0.1), 6); // mid-jump
    expect(supportHeightAt(props, 0.2, R + 0.8, 0.1)).toBeCloseTo(Math.hypot(0.2, R + 1, 0.1), 6); // landing: within a step
  });

  it("is 0 beside the prop, deep inside it, or once it is broken", () => {
    expect(supportHeightAt(props, 1.2, R + 1, 0)).toBe(0);
    expect(supportHeightAt(props, 0, R + 0.3, 0)).toBe(0);
    expect(supportHeightAt(props, 0.2, R + 1, 0.1, (i) => i !== 0)).toBe(0);
  });

  it("uses a compound prop's top (the pillar cap)", () => {
    expect(supportHeightAt(props, 5.3, R + 4.4, 0.3)).toBeCloseTo(Math.hypot(5.3, R + 4.2, 0.3), 6);
  });
});

describe("real placement", () => {
  const list = bodyBreakables(createTerrain("arcadia"));

  it("a player inside any Arcadia prop is pushed exactly clear of it (tilted frames)", () => {
    for (const b of list) {
      // Feet a little above the base at a point inside the footprint.
      const lx = b.hx * 0.4, lz = (b.shape === 0 ? b.hz : b.hx) * -0.3, ly = 0.05;
      const p: XYZ = {
        x: b.px + b.rx * lx + b.ux * ly + b.fx * lz,
        y: b.py + b.ry * lx + b.uy * ly + b.fy * lz,
        z: b.pz + b.rz * lx + b.uz * ly + b.fz * lz,
      };
      expect(pushOutOfBreakable(b, p, r, H, step, emptyContact()), b.id).toBe(true);
      expect(distanceToBreakable(b, p.x, p.y, p.z), b.id).toBeCloseTo(r, 6);
    }
  });

  it("the collider finds the prop under the player through the grid", () => {
    const collider = new BreakableCollider(list);
    for (const b of list.slice(0, 100)) {
      const p: XYZ = { x: b.px + b.ux * 0.05, y: b.py + b.uy * 0.05, z: b.pz + b.uz * 0.05 };
      const c = emptyContact();
      collider.resolve(p, (i) => i === b.index, c);
      expect(c.pushed, b.id).toBe(true);
      expect(distanceToBreakable(b, p.x, p.y, p.z), b.id).toBeGreaterThan(r - 1e-6);
    }
  });
});

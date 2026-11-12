// Spell effects, the parts a test can see without a GPU: what runs every frame allocates nothing
// (review 6), and the pools hand their meshes out and take them back.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { SpellFx, type Burst } from "./spellFx.ts";

const terrain = () => ({ body: { radius: 500, waterLevel: 0 }, groundHeight: () => 1 }) as never;
const at = () => new THREE.Vector3(0, 501, 0);

/** Run `fn` counting every array iterator made meanwhile (`for…of` over an array, array destructuring). */
function arrayIterators(fn: () => void): number {
  const proto = Array.prototype as unknown as Record<symbol, (this: unknown[]) => IterableIterator<unknown>>;
  const real = proto[Symbol.iterator]!;
  let n = 0;
  proto[Symbol.iterator] = function (this: unknown[]) {
    n++;
    return real.call(this);
  };
  try {
    fn();
  } finally {
    proto[Symbol.iterator] = real;
  }
  return n;
}

describe("spell effects: the per-frame path", () => {
  it("a falling star and a full set of effects are animated without making arrays or iterators (review 6)", () => {
    const bursts: Parameters<Burst>[] = [];
    const fx = new SpellFx(new THREE.Scene(), terrain, (...a) => void bursts.push(a));
    fx.starFall(1, at(), 4, 1200);
    fx.frost(at(), 5, 3000);
    fx.ward("w", at, 4000);
    fx.blink(at(), new THREE.Vector3(8, 501, 0));
    expect(fx.live).toBeGreaterThan(10);
    bursts.length = 0;
    let live = 0;
    const made = arrayIterators(() => {
      for (let i = 0; i < 40; i++) fx.update(1 / 60); // two thirds of a second of the fall
      live = fx.live;
    });
    expect(made).toBe(0);
    expect(live).toBeGreaterThan(0);
    // The star shed sparks on the way, every time with the one shared options object.
    const sparks = bursts.filter((b) => b[2] === 3 && b[3]?.lift === -1);
    expect(sparks.length).toBeGreaterThan(10);
    expect(new Set(sparks.map((b) => b[3])).size).toBe(1);
    fx.dispose();
  });

  it("effects end by themselves and give their meshes back", () => {
    const fx = new SpellFx(new THREE.Scene(), terrain, () => {});
    fx.starFall(7, at(), 4, 1200);
    fx.starImpact(7, at(), 4);
    expect(fx.live).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) fx.update(1 / 20);
    expect(fx.live).toBe(0);
    fx.dispose();
  });
});

describe("Wishfall's fall and landing", () => {
  const visible = (fx: SpellFx, prefix: string) => fx.group.children.filter((m) => m.visible && m.name.startsWith(prefix)) as THREE.Mesh[];
  const height = (v: THREE.Vector3) => v.length() - 501;

  it("the star comes from high above at a slight angle, gathers speed, and its tail tapers behind it", () => {
    const fx = new SpellFx(new THREE.Scene(), terrain, () => {});
    const target = at();
    fx.starFall(3, target, 4, 1200);
    // The warning ring, the path line, two tails (outer and core) and the head in its corona.
    expect(visible(fx, "spellDecal")).toHaveLength(1);
    expect(visible(fx, "spellBeam")).toHaveLength(1);
    expect(visible(fx, "spellTail")).toHaveLength(2);
    expect(visible(fx, "spellGlow")).toHaveLength(2);
    const head = visible(fx, "spellGlow")[0]!;
    const tail = visible(fx, "spellTail")[0]!;
    const start = head.position.clone();
    expect(height(start)).toBeGreaterThan(45);
    // A slight angle: 15–25° off straight down.
    const up = target.clone().normalize();
    const lean = (Math.acos(start.clone().sub(target).normalize().dot(up)) * 180) / Math.PI;
    expect(lean).toBeGreaterThan(12);
    expect(lean).toBeLessThan(25);
    // The tail's geometry is a cone: a point far behind, one unit wide at the star.
    const p = tail.geometry.getAttribute("position") as THREE.BufferAttribute;
    let wideAtHead = 0, wideAtEnd = 0;
    for (let i = 0; i < p.count; i++) {
      const rad = Math.hypot(p.getX(i), p.getY(i));
      if (p.getZ(i) > 0.99) wideAtHead = Math.max(wideAtHead, rad);
      if (p.getZ(i) < 0.01) wideAtEnd = Math.max(wideAtEnd, rad);
    }
    expect(wideAtHead).toBeCloseTo(1, 3);
    expect(wideAtEnd).toBeLessThan(0.05);
    // Halfway through the warning it is still well up; in the last third it is low enough to be in view; it speeds up.
    const heights: number[] = [];
    for (let i = 1; i <= 71; i++) {
      fx.update(1 / 60);
      heights.push(height(head.position));
    }
    const at36 = heights[35]!, at54 = heights[53]!, at66 = heights[65]!;
    expect(at36).toBeGreaterThan(25);
    expect(at54).toBeLessThan(22);
    expect(at66).toBeLessThan(8);
    expect(heights[10]! - heights[20]!).toBeLessThan(heights[50]! - heights[60]!);
    // The tail ends at the star and points back up the way it came.
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(tail.quaternion);
    expect(tail.position.clone().addScaledVector(back, tail.scale.z).distanceTo(head.position)).toBeLessThan(0.01);
    expect(tail.scale.z).toBeGreaterThan(20);
    fx.dispose();
  });

  it("the landing clears the fall, flashes, runs a shockwave out, and leaves a scorch that smoulders and fades", () => {
    const bursts: Parameters<Burst>[] = [];
    const fx = new SpellFx(new THREE.Scene(), terrain, (...a) => void bursts.push(a));
    fx.starFall(4, at(), 4, 1200);
    for (let i = 0; i < 72; i++) fx.update(1 / 60);
    bursts.length = 0;
    fx.starImpact(4, at(), 4);
    expect(visible(fx, "spellTail")).toHaveLength(0);
    expect(visible(fx, "spellDecal")).toHaveLength(2); // the shockwave and the scorch; the warning ring is gone
    expect(visible(fx, "spellGlow").length).toBeGreaterThanOrEqual(3); // the flash and the fireball
    expect(bursts.length).toBe(2); // the spray of embers and sparks
    // Two seconds on: the shockwave is over, the scorch is there and embers have kept lifting off it.
    bursts.length = 0;
    for (let i = 0; i < 120; i++) fx.update(1 / 60);
    expect(visible(fx, "spellDecal")).toHaveLength(1);
    expect(visible(fx, "spellGlow")).toHaveLength(0);
    expect(bursts.length).toBeGreaterThan(6);
    expect(bursts.every((b) => (b[3]?.lift ?? 0) > 0 && (b[3]?.life?.[1] ?? 0) > 2)).toBe(true);
    // The embers stop after a few seconds; the scorch fades out and gives its mesh back.
    for (let i = 0; i < 120; i++) fx.update(1 / 60);
    bursts.length = 0;
    for (let i = 0; i < 60; i++) fx.update(1 / 60);
    expect(bursts).toHaveLength(0);
    expect(visible(fx, "spellDecal")).toHaveLength(1);
    for (let i = 0; i < 180; i++) fx.update(1 / 60);
    expect(fx.live).toBe(0);
    fx.dispose();
  });
});

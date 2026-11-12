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

// The optional sculpted-weapon preload (weapons review 1): it has a deadline, after which the loading
// screen moves on with the code-built models, and a download that lands late changes nothing (the
// warm-up compiled the materials it had).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type Mod = typeof import("./sculpted.ts");

const scene = () => {
  const s = new THREE.Group();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1), new THREE.MeshBasicMaterial()));
  return { scene: s };
};

describe("sculpted weapon preload", () => {
  let mod: Mod;
  let stuck: string;
  let release: (() => void) | null = null;
  let loader: GLTFLoader;
  const texture = () => Promise.resolve(new THREE.Texture());

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mod = await import("./sculpted.ts");
    stuck = mod.SCULPTED_WEAPONS[0]!;
    loader = {
      loadAsync: (url: string) =>
        url.endsWith(`/${stuck}.glb`) ? new Promise((res) => (release = () => res(scene()))) : Promise.resolve(scene()),
    } as unknown as GLTFLoader;
  });
  afterEach(() => {
    vi.useRealTimers();
    release = null;
  });

  it("a download that never settles doesn't hold the loading screen past the deadline; the rest are sculpted", async () => {
    let settled = false;
    void mod.preloadSculptedWeapons(loader, false, () => {}, { texture }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(mod.SCULPTED_PRELOAD_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(mod.hasSculptedWeapon(stuck)).toBe(false);
    for (const id of mod.SCULPTED_WEAPONS.slice(1)) expect(mod.hasSculptedWeapon(id)).toBe(true);
  });

  it("one that lands after the deadline keeps the code-built model (no material swap after the warm-up)", async () => {
    const done = mod.preloadSculptedWeapons(loader, false, () => {}, { texture });
    await vi.advanceTimersByTimeAsync(mod.SCULPTED_PRELOAD_DEADLINE_MS);
    await done;
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(mod.hasSculptedWeapon(stuck)).toBe(false);
    expect(mod.sculptedWeapon(stuck, 0)).toBeNull();
  });

  it("with everything in time it resolves as soon as the files are in", async () => {
    const quick = { loadAsync: () => Promise.resolve(scene()) } as unknown as GLTFLoader;
    let settled = false;
    void mod.preloadSculptedWeapons(quick, false, () => {}, { texture }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    for (const id of mod.SCULPTED_WEAPONS) expect(mod.hasSculptedWeapon(id)).toBe(true);
  });
});

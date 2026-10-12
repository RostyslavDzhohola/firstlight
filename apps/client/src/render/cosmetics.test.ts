import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { buildCosmetic, cosmeticWarmupHook, CosmeticRig, type Socketed } from "./Cosmetics.ts";
import { COSMETICS } from "@firstlight/shared/content/items";
import { stubCanvasDocument, watchDisposals, type DisposalWatch } from "./disposeWatch.testutil.ts";

let restore: () => void;
beforeAll(() => {
  restore = stubCanvasDocument(); // the static cloak's noise texture
});
afterAll(() => restore());

/** Records what the rig attaches to each socket. */
function fakeAvatar() {
  const sockets = new Map<string, THREE.Object3D>();
  const avatar: Socketed = {
    attach(slot, obj) {
      sockets.get(slot)?.removeFromParent();
      sockets.delete(slot);
      if (obj) sockets.set(slot, obj);
    },
  };
  return { avatar, sockets };
}

describe("CosmeticRig", () => {
  it("frees what it built when the outfit changes or the rig goes, keeping the shared materials", () => {
    const { avatar, sockets } = fakeAvatar();
    const rig = new CosmeticRig(avatar);
    rig.set("woolly_beanie,static_cloak,fox_mask");
    expect(sockets.size).toBe(3);
    const w: DisposalWatch = { all: new Set(), disposed: new Set() };
    for (const g of sockets.values()) watchDisposals(g, w);
    const geos = [...w.all].filter((x) => (x as THREE.BufferGeometry).isBufferGeometry);
    const textures = [...w.all].filter((x) => (x as THREE.Texture).isTexture);
    expect(textures.length).toBe(1);
    rig.set("fox_mask");
    expect(sockets.size).toBe(1);
    for (const x of [...geos, ...textures]) expect(w.disposed.has(x)).toBe(true);
    const shared = [...w.all].filter((x) => (x as THREE.Material).isMaterial && !(x as { map?: unknown }).map);
    expect(shared.length).toBeGreaterThan(0);
    for (const m of shared) expect(w.disposed.has(m)).toBe(false);
    const w2 = watchDisposals([...sockets.values()][0]!);
    rig.dispose();
    expect(sockets.size).toBe(0);
    for (const x of w2.all) if ((x as THREE.BufferGeometry).isBufferGeometry) expect(w2.disposed.has(x)).toBe(true);
  });
});


describe("M11 procedural cosmetics", () => {
  it.each(COSMETICS.slice(31))("builds $id within the triangle budget with finite bounds", ({ id }) => {
    const obj = buildCosmetic(id, [])!;
    const meshes: THREE.Mesh[] = [];
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes.length).toBeGreaterThan(1);
    const triangles = meshes.reduce((n, mesh) => n + (mesh.geometry.index?.count ?? mesh.geometry.attributes.position!.count) / 3, 0);
    expect(triangles).toBeLessThanOrEqual(1500);
    const bounds = new THREE.Box3().setFromObject(obj);
    expect([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)).toBe(true);
    expect(bounds.getSize(new THREE.Vector3()).length()).toBeLessThan(2);
  });

  it("warms every cosmetic and keeps the same samples across scene changes without disposal", () => {
    const scene = new THREE.Scene();
    const hook = cosmeticWarmupHook(scene, () => new THREE.Vector3(10, 20, 30));
    hook.forceAll(true);
    const group = scene.getObjectByName("cosmeticWarmup")!;
    expect(group.visible).toBe(false);
    expect(group.children.map((c) => c.name)).toEqual(COSMETICS.map((c) => `cosmetic:${c.id}`));
    const watch = watchDisposals(group);
    hook.forceAll(false);
    expect(group.parent).toBe(null);
    expect(watch.disposed.size).toBe(0);
    const other = new THREE.Scene();
    const next = cosmeticWarmupHook(other, () => new THREE.Vector3(40, 50, 60));
    next.forceAll(true);
    expect(other.getObjectByName("cosmeticWarmup")).toBe(group);
    expect(group.position.toArray()).toEqual([40, 50, 60]);
    next.forceAll(false);
    expect(watch.disposed.size).toBe(0);
  });
});

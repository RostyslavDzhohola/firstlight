import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { disposeTree, releaseObjects } from "./dispose.ts";
import { watchDisposals } from "./disposeWatch.testutil.ts";

function tree() {
  const sharedGeo = new THREE.BoxGeometry();
  const sharedMat = new THREE.MeshBasicNodeMaterial();
  const ownTex = new THREE.Texture();
  const ownGeo = new THREE.SphereGeometry();
  const ownMat = new THREE.MeshStandardNodeMaterial({ map: ownTex });
  const spriteTex = new THREE.Texture();
  const spriteMat = new THREE.SpriteNodeMaterial({ map: spriteTex });
  const root = new THREE.Group();
  const inner = new THREE.Group();
  const own = new THREE.Mesh(ownGeo, ownMat);
  const shared = new THREE.Mesh(sharedGeo, sharedMat);
  const sprite = new THREE.Sprite(spriteMat);
  inner.add(own, sprite);
  root.add(inner, shared);
  return { root, own, shared, sprite, sharedGeo, sharedMat, ownGeo, ownMat, ownTex, spriteMat, spriteTex };
}

describe("disposeTree", () => {
  it("frees what the subtree owns and keeps the shared resources", () => {
    const t = tree();
    const w = watchDisposals(t.root);
    const keep = new Set<object>([t.sharedGeo, t.sharedMat]);
    const n = disposeTree(t.root, (r) => keep.has(r));
    expect(n).toEqual({ objects: 3, geometries: 1, materials: 2, textures: 2 });
    for (const x of [t.own, t.shared, t.sprite, t.ownGeo, t.ownMat, t.ownTex, t.spriteMat, t.spriteTex]) expect(w.disposed.has(x)).toBe(true);
    expect(w.disposed.has(t.sharedGeo)).toBe(false);
    expect(w.disposed.has(t.sharedMat)).toBe(false);
  });

  it("never frees three's shared sprite quad", () => {
    const a = new THREE.Sprite(new THREE.SpriteNodeMaterial());
    const b = new THREE.Sprite(new THREE.SpriteNodeMaterial());
    expect(a.geometry).toBe(b.geometry);
    let quadDisposed = false;
    a.geometry.addEventListener("dispose", () => (quadDisposed = true));
    disposeTree(a);
    expect(quadDisposed).toBe(false);
  });
});

describe("releaseObjects", () => {
  it("frees per-object render state only", () => {
    const t = tree();
    const w = watchDisposals(t.root);
    expect(releaseObjects(t.root)).toBe(3);
    expect([...w.disposed].sort((a, b) => (a as THREE.Object3D).id - (b as THREE.Object3D).id)).toEqual(
      [t.own, t.shared, t.sprite].sort((a, b) => a.id - b.id),
    );
  });
});

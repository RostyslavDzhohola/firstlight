import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { CosmeticRig, type Socketed } from "./Cosmetics.ts";
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

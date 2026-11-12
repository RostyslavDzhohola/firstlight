// The sun shadow pass's main-thread savings (#49, D-framerate-2), headless through three's real shadow
// node (headlessRender.testutil.ts: three's renderer and backend on a recording fake GPU): the shadow
// map skips the second walk over the scene's matrices, frames after the first recompute no caster's
// cache key with a cutout caster among opaque ones, a caster whose alpha test changes still gets its
// shadow rebuilt, and the shadow map draws the same casters at their current positions.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { frames, headless, type Internals } from "./headlessRender.testutil.ts";
import { installShadowPass } from "./shadowPass.ts";

afterEach(() => vi.unstubAllGlobals());

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  meshes: THREE.Mesh[];
  /** An opaque caster on a material of its own (its alpha test is switched on in one test). */
  lone: THREE.Mesh;
}

/** A sun with a shadow map over cutout casters (leaves, a cutout sign) mixed with opaque ones. */
function stage(): Stage {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(5, 10, 5);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const opaque = new THREE.MeshStandardNodeMaterial();
  const cutout = new THREE.MeshStandardNodeMaterial({ alphaTest: 0.5 });
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(geo, i % 3 === 1 ? cutout : opaque);
    m.position.set(i - 4, 0, -i * 0.5); // interleaved in depth, as the shadow pass sorts them
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    meshes.push(m);
  }
  const lone = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial());
  lone.position.set(0, 0, 1);
  lone.castShadow = true;
  scene.add(lone);
  meshes.push(lone);
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
  camera.position.set(0, 3, 10);
  camera.lookAt(0, 0, 0);
  return { scene, camera, meshes, lone };
}

const isShadow = (ro: any) => ro.material?.isShadowPassMaterial === true;

/** three's RenderObject prototype (not exported): from any render object the renderer made. */
const renderObjectProto = (r: Internals) => Object.getPrototypeOf([...(r as any)._objects._renderObjects][0]);

/** Count calls of `fn` on `obj` while `body` runs. */
async function counting(obj: any, fn: string, body: () => Promise<unknown>, filter: (self: any) => boolean = () => true): Promise<number> {
  const own = obj[fn];
  let n = 0;
  obj[fn] = function (this: unknown, ...a: unknown[]) {
    if (filter(this)) n++;
    return own.apply(this, a);
  };
  try {
    await body();
  } finally {
    obj[fn] = own;
  }
  return n;
}

/**
 * `n` frames as the animation loop draws them (three's node frame advances each frame: the shadow node
 * draws its map once per frame and camera). The first call compiles first, as the warm-up does.
 */
async function play(r: Internals, scene: THREE.Scene, camera: THREE.Camera, n: number): Promise<void> {
  if (!(r as any).__compiled) {
    (r as any).__compiled = true;
    await frames(r, scene, camera, 0);
  }
  for (let i = 0; i < n; i++) {
    r.gpu.frame++;
    (r as any)._nodes.nodeFrame.update();
    r.render(scene, camera);
  }
}

/** Record each draw's render object and its object's world position at the moment the GPU draws it. */
function recordDraws(r: Internals): { ro: any; y: number }[] {
  const out: { ro: any; y: number }[] = [];
  const be = r.backend as unknown as { draw(ro: any, info: unknown): unknown };
  const draw = be.draw;
  be.draw = function (this: unknown, ro: any, info: unknown) {
    out.push({ ro, y: ro.object.matrixWorld.elements[13] });
    return draw.call(this, ro, info);
  };
  return out;
}

async function withPass<T>(on: boolean, body: () => Promise<T>): Promise<T> {
  const undo = on ? installShadowPass() : null;
  if (on) expect(undo).not.toBeNull();
  try {
    return await body();
  } finally {
    undo?.();
  }
}

for (const backend of ["webgl2", "webgpu"] as const) {
  describe(`the shadow pass (${backend})`, () => {
    it("walks the scene's matrices once a frame (three's own pass walks them again for the shadow map)", async () => {
      for (const on of [false, true]) {
        await withPass(on, async () => {
          const r = await headless(backend, true);
          const { scene, camera } = stage();
          await play(r, scene, camera, 1);
          let shadows = 0;
          const walks = await counting(scene, "updateMatrixWorld", async () => {
            shadows = await counting((THREE as any).ShadowNode.prototype, "updateShadow", () => play(r, scene, camera, 3));
          });
          expect(shadows).toBe(3);
          expect(walks).toBe(on ? 3 : 6); // the main pass's, and three's own shadow pass walks again
          expect(scene.matrixWorldAutoUpdate).toBe(true);
        });
      }
    });

    it("recomputes no caster's cache key after the first frame with cutout casters among opaque ones", async () => {
      for (const on of [false, true]) {
        await withPass(on, async () => {
          const r = await headless(backend, true);
          const { scene, camera } = stage();
          await play(r, scene, camera, 2);
          const keys = await counting(renderObjectProto(r), "getCacheKey", () => play(r, scene, camera, 3), isShadow);
          if (on) expect(keys).toBe(0);
          else expect(keys).toBeGreaterThan(0); // three's own pass: the override material's version moves every frame
        });
      }
    });

    it("draws the same casters each frame, at the positions the frame moved them to", async () => {
      const shadowDraws = async (on: boolean) =>
        withPass(on, async () => {
          const r = await headless(backend, true);
          const { scene, camera, meshes } = stage();
          await play(r, scene, camera, 2);
          meshes[0]!.position.y = 2; // moved this frame: its shadow must follow
          const drawn = recordDraws(r);
          await play(r, scene, camera, 1);
          const shadow = drawn.filter((d) => isShadow(d.ro));
          return { objects: shadow.map((d) => meshes.indexOf(d.ro.object)).sort((a, b) => a - b), moved: shadow.find((d) => d.ro.object === meshes[0])?.y };
        });
      const before = await shadowDraws(false);
      const after = await shadowDraws(true);
      expect(after.objects).toEqual(before.objects);
      expect(after.objects).toHaveLength(9);
      expect(after.moved).toBe(2);
    });

    it("rebuilds a caster's shadow when its material's alpha test switches on later", async () => {
      await withPass(true, async () => {
        const r = await headless(backend, true);
        const { scene, camera, lone } = stage();
        await play(r, scene, camera, 2);
        const ros = () => [...(r as any)._objects._renderObjects].filter((ro: any) => isShadow(ro) && ro.object === lone);
        const [first] = ros();
        expect(first).toBeDefined();
        (lone.material as THREE.Material).alphaTest = 0.5;
        const drawn = recordDraws(r);
        await play(r, scene, camera, 1);
        const used = drawn.filter((d) => isShadow(d.ro) && d.ro.object === lone).map((d) => d.ro);
        expect(used).toHaveLength(1);
        expect(used[0]).not.toBe(first);
        expect(used[0].initialCacheKey).not.toBe(first.initialCacheKey);
        // …and once rebuilt, the next frames leave every caster's key alone again
        const keys = await counting(renderObjectProto(r), "getCacheKey", () => play(r, scene, camera, 2), isShadow);
        expect(keys).toBe(0);
      });
    });
  });
}

describe("installShadowPass", () => {
  it("is idempotent and undoable, and does nothing on a three without the shadow node's methods", () => {
    const proto = (THREE as any).ShadowNode.prototype;
    const own = proto.updateShadow;
    const undo = installShadowPass();
    expect(proto.updateShadow).not.toBe(own);
    const again = installShadowPass();
    expect(again).not.toBeNull();
    undo!();
    expect(proto.updateShadow).toBe(own);
    expect(installShadowPass({} as never)).toBeNull();
  });
});

// Per-object palette and coat colours (#39, D-load-4), on three's real WebGL2 and WebGPU backends over
// a recording fake GPU (headlessRender.testutil.ts): one toon material per avatar look and one horse
// material, so every palette of a look (and every coat) shares one material and node build, while
// each skinned body still draws its own colours. Frames are real renderer.render() calls with one
// scene and camera: three's own bindings manager uploads each render object's per-object uniform
// buffer (WebGL2 bufferData/bufferSubData, WebGPU queue.writeBuffer) and binds it for that draw (a
// uniform-block binding, a bind group), so each draw is checked for what the GPU would read: its own
// buffer, holding its own palette, with bodies of one material drawn in turn. AvatarView and
// HorseView are driven through their public API on stand-in assets (a 65-bone rig per look, the
// 41-bone horse).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { HORSE_COATS } from "@firstlight/shared/content/horse";
import { STARTER_LOOKS, STARTERS } from "@firstlight/shared/content/weapons";
import { ANIM } from "@firstlight/shared/net/schema";
import type { AvatarAssets } from "./avatars/assets.ts";
import { frames, headless, objectDraws, rigged, riggedGeometry, type Internals, type ObjectDraw } from "./headlessRender.testutil.ts";
import { castsLeanShadow } from "./leanShadow.ts";

const stand = vi.hoisted(() => ({ avatars: null as AvatarAssets | null, horse: null as unknown }));

// The loaded avatar assets and horse.glb, without a network: stand-ins with the real rigs' bone counts.
vi.mock("./avatars/assets.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./avatars/assets.ts")>();
  return { ...real, avatarAssets: () => stand.avatars };
});
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    async loadAsync() {
      return stand.horse;
    }
  },
}));

let avatars: typeof import("./Avatars.ts");
let horses: typeof import("./Horses.ts");
let material: typeof import("./avatars/material.ts");

const SOCKET_BONES = ["hand_r", "middle_01_r", "hand_l", "middle_01_l", "Head", "spine_03", "pelvis"];

function avatarTemplate(geo: THREE.BufferGeometry): THREE.Object3D {
  const mesh = rigged(geo, 65, new THREE.MeshBasicNodeMaterial());
  SOCKET_BONES.forEach((n, i) => void (mesh.skeleton.bones[i + 1]!.name = n));
  return new THREE.Group().add(mesh);
}

beforeAll(async () => {
  const geo = riggedGeometry(true);
  const looks = STARTER_LOOKS.flat().length;
  stand.avatars = {
    models: Array.from({ length: looks }, () => avatarTemplate(geo)),
    textures: Array.from({ length: looks }, () => ({ albedo: new THREE.Texture(), normal: new THREE.Texture() })),
    clips: new Map(),
    modelClips: [],
    pelvis: [],
    rideFoot: [],
  };
  const horse = rigged(riggedGeometry(false), 41, new THREE.MeshBasicNodeMaterial());
  const saddle = new THREE.Object3D();
  saddle.name = "saddle";
  stand.horse = { scene: new THREE.Group().add(horse, saddle), animations: [] };
  avatars = await import("./Avatars.ts");
  horses = await import("./Horses.ts");
  material = await import("./avatars/material.ts");
  await horses.preloadHorse();
});

afterEach(() => vi.unstubAllGlobals());

const linear = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [Math.fround(c.r), Math.fround(c.g), Math.fround(c.b)];
};
const holds = (colours: readonly [number, number, number][], hex: number) =>
  colours.some((c) => c.every((v, i) => Math.abs(v - linear(hex)[i]!) < 1e-6));

/** The skinned meshes (the body) of a view's root. */
function skinned(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => void ((o as THREE.SkinnedMesh).isSkinnedMesh && out.push(o as THREE.SkinnedMesh)));
  return out;
}

/** Stand `roots` in a scene seen by one camera, their `bodies` drawn in this order (renderOrder). */
function stage(roots: THREE.Object3D[], bodies: THREE.Object3D[]): { scene: THREE.Scene; camera: THREE.Camera } {
  const scene = new THREE.Scene();
  for (const root of roots) scene.add(root);
  bodies.forEach((b, i) => void (b.renderOrder = i));
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
  camera.position.set(0, 1, 6);
  camera.lookAt(0, 1, 0);
  return { scene, camera };
}

/**
 * Every draw of `bodies` used its own per-object buffer (one per body, the same in every frame) and
 * read its own colours from it, as uploaded, and none of another body's that differ from its own.
 */
function expectOwn(draws: readonly ObjectDraw[], bodies: readonly THREE.Object3D[], colourOf: (o: THREE.Object3D) => readonly number[], perBody: number) {
  expect(draws).toHaveLength(bodies.length * perBody);
  const bufferOf = new Map<THREE.Object3D, object>();
  for (const d of draws) {
    expect(d.selected, "the draw used the render object's own buffer").toBe(true);
    if (!bufferOf.has(d.object)) bufferOf.set(d.object, d.buffer);
    expect(d.buffer, "one buffer per body across frames").toBe(bufferOf.get(d.object));
    const own = colourOf(d.object);
    for (const hex of own) expect(holds(d.colours, hex), `own colour ${hex.toString(16)} (frame ${d.frame})`).toBe(true);
    for (const o of bodies) {
      if (o === d.object) continue;
      for (const hex of colourOf(o)) if (!own.includes(hex)) expect(holds(d.colours, hex), `another body's ${hex.toString(16)}`).toBe(false);
    }
  }
  expect(new Set(bufferOf.values()).size, "a buffer of its own for each body").toBe(bodies.length);
}

/** The glow (the shader's emissive colour) reads the uniform each draw's palette accent is uploaded in. */
function expectGlowFromAccent(r: Internals, draws: readonly ObjectDraw[], paletteOf: (o: THREE.Object3D) => readonly number[]) {
  for (const d of draws) {
    const [prim, , acc] = paletteOf(d.object);
    const name = (hex: number) => d.named.find((n) => holds([n.rgb], hex))?.name;
    const emissive = (r._nodes.getForRender(d.ro).fragmentShader as string).split("\n").find((l) => /\bEmissiveColor\s*=/.test(l)) ?? "";
    expect(emissive).toMatch(new RegExp(`\\b${name(acc!)}\\b`));
    expect(emissive).not.toMatch(new RegExp(`\\b${name(prim!)}\\b`));
  }
}

const bodyOf = (v: { root: THREE.Object3D }) => skinned(v.root)[0]!;

for (const backend of ["webgl2", "webgpu"] as const) {
  describe(`palette and coat colours per object (${backend})`, () => {
    it("avatars of one look in four palettes, drawn in turn over frames, share one material and build and each reads its own palette", async () => {
      const r = await headless(backend, true);
      const palettes = [0, 4, 1, 5];
      const views = palettes.map((p) => new avatars.AvatarView(p, 2, 1)); // Kappa's second look
      const bodies = views.map(bodyOf);
      expect(new Set(bodies.map((b) => b.material)).size).toBe(1);
      const { scene, camera } = stage(views.map((v) => v.root), bodies);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      const first = objectDraws(r, await frames(r, scene, camera, 1), bodies);
      const built = builds;
      const drawn = [...first, ...objectDraws(r, await frames(r, scene, camera, 2), bodies)];
      expect(builds).toBe(built); // the next frames build nothing
      expect(new Set(drawn.map((d) => r._nodes.getForRender(d.ro))).size).toBe(1); // one build for the four
      const paletteOf = (o: THREE.Object3D) => material.PALETTES[palettes[bodies.indexOf(o as THREE.SkinnedMesh)]!]!;
      expectOwn(drawn, bodies, paletteOf, 3);
      expectGlowFromAccent(r, drawn, paletteOf);
      // No palette colour is a shader constant any more.
      const fs = r._nodes.getForRender(drawn[0]!.ro).fragmentShader as string;
      for (const hex of material.PALETTES.flat()) {
        const red = String(new THREE.Color(hex).r);
        if (red.length > 6) expect(fs).not.toContain(red);
      }
      for (const v of views) v.dispose();
    });

    it("a palette change in play: the new body reads the new palette and glow in turn with its look's other avatar, no new build; then a look change", async () => {
      const r = await headless(backend, true);
      const a = new avatars.AvatarView(1, 3, 0);
      const b = new avatars.AvatarView(3, 3, 0);
      const [bodyA, bodyB] = [bodyOf(a), bodyOf(b)];
      const { scene, camera } = stage([a.root, b.root], [bodyA, bodyB]);
      const palette = (p: number) => material.PALETTES[p]!;
      expectOwn(objectDraws(r, await frames(r, scene, camera, 2), [bodyA, bodyB]), [bodyA, bodyB], (o) => palette(o === bodyA ? 1 : 3), 2);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      a.setLook(5, 3, 0); // another palette, the same look: a new body on the same material
      const renewed = bodyOf(a);
      expect(renewed).not.toBe(bodyA);
      expect(renewed.material).toBe(bodyA.material);
      [renewed.renderOrder, bodyB.renderOrder] = [0, 1];
      const after = objectDraws(r, await frames(r, scene, camera, 2), [renewed, bodyB]);
      expect(builds).toBe(0);
      expectOwn(after, [renewed, bodyB], (o) => palette(o === renewed ? 5 : 3), 2);
      expectGlowFromAccent(r, after, (o) => palette(o === renewed ? 5 : 3));
      a.setLook(5, 0, 0); // another look: its own material, the palette kept
      const relooked = bodyOf(a);
      expect(relooked.material).not.toBe(bodyA.material);
      relooked.renderOrder = 0;
      const looked = objectDraws(r, await frames(r, scene, camera, 2), [relooked, bodyB]);
      expect(builds).toBe(1); // that look's own build, once
      expectOwn(looked, [relooked, bodyB], (o) => palette(o === relooked ? 5 : 3), 2);
      a.dispose();
      b.dispose();
    });

    it("horses of four coats, drawn in turn over frames, share one material and build and each reads its own coat", async () => {
      const r = await headless(backend, true);
      const coats = [0, 5, 2, 3];
      const views = coats.map((c) => new horses.HorseView(c));
      const bodies = views.map(bodyOf);
      expect(new Set(bodies.map((b) => b.material)).size).toBe(1);
      const { scene, camera } = stage(views.map((v) => v.root), bodies);
      const drawn = objectDraws(r, await frames(r, scene, camera, 3), bodies);
      expect(new Set(drawn.map((d) => r._nodes.getForRender(d.ro))).size).toBe(1);
      expectOwn(drawn, bodies, (o) => HORSE_COATS[coats[bodies.indexOf(o as THREE.SkinnedMesh)]!]!, 3);
      for (const v of views) v.dispose();
    });

    it("after the warm-up, no look, palette, held item or coat builds anything on first sight (shadows included)", async () => {
      const r = await headless(backend, true);
      const scene = new THREE.Scene();
      const p = new THREE.Vector3(0, 1000, 0);
      const at = () => p.clone();
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(5, 1010, 5);
      sun.target.position.copy(p);
      sun.castShadow = true;
      scene.add(sun, sun.target);
      const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
      camera.position.set(0, 1001, 6);
      camera.lookAt(p);
      const hooks = [avatars.avatarWarmupHook(scene, at), horses.horseWarmupHook(scene, at)];
      for (const h of hooks) h.forceAll(true);
      const kept = ["avatarWarmup", "horseWarmup"].map((n) => scene.getObjectByName(n)!);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      try {
        for (const k of kept) k.visible = true; // warmup() shows the hidden samples while it runs
        await frames(r, scene, camera, 2);
      } finally {
        for (const k of kept) k.visible = false;
        for (const h of hooks) h.forceAll(false);
      }
      const warm = builds;
      expect(warm).toBeGreaterThan(0);
      // In play: every starter's every look in every palette, holding its own weapon, and every coat.
      const views: { root: THREE.Object3D; dispose(): void }[] = [];
      STARTERS.forEach((_, s) => STARTER_LOOKS[s]!.forEach((_l, look) => {
        for (let pal = 0; pal < material.PALETTES.length; pal++) {
          const v = new avatars.AvatarView(pal, s, look);
          v.set(p.x, p.y, p.z, 1, 0, 0, ANIM.IDLE, 0);
          views.push(v);
        }
      }));
      HORSE_COATS.forEach((_, c) => {
        const h = new horses.HorseView(c);
        h.set(p.x, p.y, p.z, 1, 0, 0, 0, false, 0);
        views.push(h);
      });
      for (const v of views) scene.add(v.root);
      await frames(r, scene, camera, 2);
      expect(builds - warm).toBe(0);
      for (const v of views) v.dispose();
    });
  });
}

describe("the shared materials", () => {
  it("one toon material per look and one horse material, all casting lean shadows", () => {
    const tex = { albedo: new THREE.Texture(), normal: new THREE.Texture() };
    const look = material.avatarMaterial(tex);
    expect(material.avatarMaterial(tex)).toBe(look);
    expect(material.avatarMaterial({ albedo: new THREE.Texture(), normal: tex.normal })).not.toBe(look);
    expect(horses.horseMaterial()).toBe(horses.horseMaterial());
    expect(castsLeanShadow(look)).toBe(true);
    expect(castsLeanShadow(horses.horseMaterial())).toBe(true);
  });
});

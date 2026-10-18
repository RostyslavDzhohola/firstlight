// Per-object palette and coat colours (#39, D-load-4), headless through three's own render path
// (Renderer._renderObjectDirect with its GPU calls stubbed, headlessRender.testutil.ts): one toon
// material per avatar look and one horse material, so every palette of a look (and every coat)
// shares one material and node build, while each skinned mesh still draws its own colours: three runs
// the per-object uniforms' update for the drawn mesh right before it writes that draw's own uniform
// buffer, for alternating meshes of one material too. AvatarView and HorseView are driven through
// their public API on stand-in assets (a 65-bone avatar rig per look, the 41-bone horse).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { HORSE_COATS } from "@firstlight/shared/content/horse";
import { STARTER_LOOKS, STARTERS } from "@firstlight/shared/content/weapons";
import type { AvatarAssets } from "./avatars/assets.ts";
import { coloursIn, headless, mainPass, rigged, riggedGeometry, shadowPass, type MainDrawn } from "./headlessRender.testutil.ts";
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

/** Every mesh of `root` (bodies, held items, capsules), and those of them casting shadows. */
function meshes(root: THREE.Object3D, casting = false): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => void ((o as THREE.Mesh).isMesh && (!casting || o.castShadow) && out.push(o as THREE.Mesh)));
  return out;
}

/** Each draw holds its own mesh's three colours and none of the other's that differ from its own. */
function expectOwnColours(drawn: readonly MainDrawn[], colourOf: (o: THREE.Object3D) => readonly number[]) {
  const all = new Set(drawn.map((d) => d.object));
  for (const d of drawn) {
    const own = colourOf(d.object);
    for (const hex of own) expect(holds(d.colours, hex), `own colour ${hex.toString(16)}`).toBe(true);
    for (const o of all) {
      if (o === d.object) continue;
      for (const hex of colourOf(o)) if (!own.includes(hex)) expect(holds(d.colours, hex), `other's ${hex.toString(16)}`).toBe(false);
    }
  }
}

for (const backend of ["webgl2", "webgpu"] as const) {
  describe(`palette and coat colours per object (${backend})`, () => {
    it("two avatars of one look in different palettes share one material and build, and each draws its own palette", async () => {
      const r = await headless(backend, true);
      const a = new avatars.AvatarView(0, 2, 1); // Kappa's second look, Ivory
      const b = new avatars.AvatarView(4, 2, 1); // the same look, Ember
      const [ma] = skinned(a.root);
      const [mb] = skinned(b.root);
      expect(ma!.material).toBe(mb!.material);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      const scene = new THREE.Scene();
      const first = mainPass(r, scene, [ma!]);
      const one = builds;
      const drawn = [...first, ...mainPass(r, scene, [mb!, ma!, mb!])]; // alternating meshes of one material
      expect(builds).toBe(one); // the second palette built nothing
      expect(new Set(drawn.map((d) => d.state)).size).toBe(1);
      const paletteOf = (o: THREE.Object3D) => material.PALETTES[o === ma ? 0 : 4]!;
      expectOwnColours(drawn, paletteOf);
      // Each mesh keeps a buffer of its own: after the alternation each still holds its own palette.
      expect(drawn[0]!.buffers[0]).not.toBe(drawn[1]!.buffers[0]);
      expectOwnColours(drawn.slice(0, 2).map((d) => ({ ...d, colours: coloursIn(d.buffers) })), paletteOf);
      // No palette colour is a shader constant any more (the emissive accent included).
      const fs = drawn[0]!.state.fragmentShader as string;
      for (const hex of material.PALETTES.flat()) {
        const red = String(new THREE.Color(hex).r);
        if (red.length > 6) expect(fs).not.toContain(red);
      }
      a.dispose();
      b.dispose();
    });

    it("an avatar given another palette (setLook) draws it with the same look's material", async () => {
      const r = await headless(backend, true);
      const a = new avatars.AvatarView(1, 3, 0);
      const before = skinned(a.root)[0]!.material;
      a.setLook(5, 3, 0);
      const [m] = skinned(a.root);
      expect(m!.material).toBe(before);
      const [d] = mainPass(r, new THREE.Scene(), [m!]);
      for (const hex of material.PALETTES[5]!) expect(holds(d!.colours, hex)).toBe(true);
      expect(holds(d!.colours, material.PALETTES[1]![0])).toBe(false);
      a.setLook(5, 0, 0); // another look: its own material
      expect(skinned(a.root)[0]!.material).not.toBe(before);
      a.dispose();
    });

    it("horses of different coats share one material and build, and each draws its own coat", async () => {
      const r = await headless(backend, true);
      const h0 = new horses.HorseView(0);
      const h5 = new horses.HorseView(5);
      const [m0] = skinned(h0.root);
      const [m5] = skinned(h5.root);
      expect(m0!.material).toBe(m5!.material);
      const drawn = mainPass(r, new THREE.Scene(), [m0!, m5!, m0!, m5!]);
      expect(new Set(drawn.map((d) => d.state)).size).toBe(1);
      expectOwnColours(drawn, (o) => HORSE_COATS[o === m0 ? 0 : 5]!);
      h0.dispose();
      h5.dispose();
    });

    it("after the warm-up, no look, palette, held item or coat builds anything on first sight", async () => {
      const r = await headless(backend, true);
      const scene = new THREE.Scene();
      const at = () => new THREE.Vector3(0, 1000, 0);
      avatars.avatarWarmupHook(scene, at).forceAll(true);
      horses.horseWarmupHook(scene, at).forceAll(true);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      mainPass(r, scene, meshes(scene));
      shadowPass(r, meshes(scene, true));
      const warm = builds;
      expect(warm).toBeGreaterThan(0);
      // In play: every starter's every look in every palette, holding its own weapon, and every coat.
      const views: { root: THREE.Object3D; dispose(): void }[] = [];
      STARTERS.forEach((_, s) => STARTER_LOOKS[s]!.forEach((_l, look) => {
        for (let p = 0; p < material.PALETTES.length; p++) views.push(new avatars.AvatarView(p, s, look));
      }));
      HORSE_COATS.forEach((_, c) => views.push(new horses.HorseView(c)));
      const play = new THREE.Group().add(...views.map((v) => v.root));
      mainPass(r, scene, meshes(play));
      shadowPass(r, meshes(play, true));
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

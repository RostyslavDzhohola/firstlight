// The HD art packs' swap on three's real WebGL2 and WebGPU backends over a recording fake GPU
// (headlessRender.testutil.ts): the town strips, a look's maps and the vegetation atlas are uploaded in
// slices while the shipped textures draw, rebound in the same materials (no new node build in the
// frames after), the shipped ones released on the GPU; a tier drop binds them again (no build either).

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { frames, headless, rigged, riggedGeometry, type Internals } from "../headlessRender.testutil.ts";
import { stripTexture } from "../townAssets.ts";
import { townMaterial, townStripSlot } from "../townMaterial.ts";
import { avatarMaterial, rebindAvatarTextures } from "../avatars/material.ts";
import { vegetationAtlasSlot, vegetationMaterial } from "../vegetationAssets.ts";
import { artPacksEnv, likeShipped } from "./env.ts";

afterEach(() => vi.unstubAllGlobals());

type TexData = { initialized?: boolean; bindGroups?: Set<unknown> };
const texData = (r: Internals, t: THREE.Texture): TexData | null => {
  const textures = (r as unknown as { _textures: { has(t: object): boolean; get(t: object): TexData } })._textures;
  return textures.has(t) ? textures.get(t) : null;
};
const boundInDraws = (r: Internals, t: THREE.Texture) => (texData(r, t)?.bindGroups?.size ?? 0) > 0;

function scene(...meshes: THREE.Object3D[]) {
  const s = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  s.add(sun, sun.target, new THREE.HemisphereLight(0x8899ff, 0x443322, 1), ...meshes);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 2, 6);
  camera.lookAt(0, 0, 0);
  return { scene: s, camera };
}

function townGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
  g.setAttribute("townMat", new THREE.BufferAttribute(new Uint8Array([1, 200, 0, 0, 1, 200, 0, 0, 1, 200, 0, 0]), 4, true));
  g.setIndex([0, 1, 2]);
  return g;
}

function vegetationGeometry() {
  const g = townGeometry();
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
  g.setAttribute("iWind", new THREE.InstancedBufferAttribute(new Float32Array([0.3]), 1));
  return g;
}

/** A 2D texture like the loaders make them (an image three uploads; no DOM decoder in node). */
function image2d(w: number, srgb = true): THREE.Texture {
  const t = new THREE.Texture({ width: w, height: w } as never);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** Upload `t` as the packs do: every step, one per frame. */
async function upload(r: Internals, t: THREE.Texture, draw: () => Promise<unknown>) {
  const steps = artPacksEnv(r).uploadSteps(t);
  for (const step of steps) {
    step();
    await draw();
  }
  return steps.length;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  // The vegetation materials are cached per kind for the app's lifetime: each backend uses its own kinds.
  const [kindA, kindB] = backend === "webgl2" ? (["oak", "pine"] as const) : (["blossom", "bush"] as const);
  describe(`HD art pack swap (${backend})`, () => {
    it("town strips: sliced upload, rebind in every material made from them, no new build; a tier drop binds the shipped strips again", async () => {
      const r = await headless(backend, true);
      const layers = 3;
      const color = stripTexture(new Uint8Array(4 * 4 * 4 * layers).fill(200), 4, layers, true);
      const normal = stripTexture(new Uint8Array(4 * 4 * 4 * layers).fill(128), 4, layers, false);
      const meshes = (["opaque", "cutout"] as const).map((k) => new THREE.Mesh(townGeometry(), townMaterial(k, true, color, normal)));
      const { scene: s, camera } = scene(...meshes);
      await frames(r, s, camera, 2);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      const hdColor = likeShipped(stripTexture(new Uint8Array(8 * 8 * 4 * layers).fill(210), 8, layers, true), color);
      const hdNormal = likeShipped(stripTexture(new Uint8Array(8 * 8 * 4 * layers).fill(128), 8, layers, false), normal);
      const steps = (await upload(r, hdColor, () => frames(r, s, camera, 1))) + (await upload(r, hdNormal, () => frames(r, s, camera, 1)));
      expect(steps, "one layer per step").toBe(6);
      expect(texData(r, hdColor)?.initialized).toBe(true);
      expect(boundInDraws(r, hdColor), "uploaded, not drawn yet").toBe(false);
      expect((hdColor.image as { data: unknown }).data, "the CPU copy is freed once on the GPU").toBeNull();
      // swap: one frame
      townStripSlot(color).set(hdColor);
      townStripSlot(normal).set(hdNormal);
      color.dispose();
      normal.dispose();
      await frames(r, s, camera, 3);
      expect(builds, "no new program after the swap").toBe(0);
      expect(boundInDraws(r, hdColor) && boundInDraws(r, hdNormal)).toBe(true);
      expect(texData(r, color), "the shipped strip is off the GPU").toBeNull();
      // A material made after the swap (another site of the same kit) draws the HD strip, keyed as before.
      expect(townMaterial("opaque", false, color, normal)).not.toBe(meshes[0]!.material);
      // tier drop: the shipped strips again (they re-upload from their CPU copy), the HD ones released
      townStripSlot(color).set(color);
      townStripSlot(normal).set(normal);
      hdColor.dispose();
      hdNormal.dispose();
      builds = 0;
      await frames(r, s, camera, 2);
      expect(builds).toBe(0);
      expect(boundInDraws(r, color)).toBe(true);
      expect(texData(r, hdColor)).toBeNull();
    });

    it("a look's albedo and normal map: rebind, no new build", async () => {
      const r = await headless(backend, true);
      const set = { albedo: image2d(8), normal: image2d(8, false) };
      const mesh = rigged(riggedGeometry(true), 4, avatarMaterial(set));
      const { scene: s, camera } = scene(mesh);
      await frames(r, s, camera, 2);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      const hd = { albedo: likeShipped(image2d(16), set.albedo), normal: likeShipped(image2d(16, false), set.normal) };
      await upload(r, hd.albedo, () => frames(r, s, camera, 1));
      await upload(r, hd.normal, () => frames(r, s, camera, 1));
      const base = { ...set };
      rebindAvatarTextures(set, hd);
      base.albedo.dispose();
      base.normal.dispose();
      await frames(r, s, camera, 3);
      expect(builds).toBe(0);
      expect(mesh.material).toBe(avatarMaterial(set));
      expect(boundInDraws(r, hd.albedo) && boundInDraws(r, hd.normal)).toBe(true);
      expect((hd.albedo.image as { width: number }).width, "the image is closed; its size is kept").toBe(16);
    });

    it("the vegetation atlas: rebind in the near materials (node and map), no new build", async () => {
      const r = await headless(backend, true);
      const atlas = image2d(8);
      const near = vegetationMaterial(kindA, atlas);
      const mesh = new THREE.InstancedMesh(vegetationGeometry(), near, 1);
      const { scene: s, camera } = scene(mesh);
      await frames(r, s, camera, 2);
      let builds = 0;
      r.debug.onNodeBuilderCreated = () => void builds++;
      const hd = likeShipped(image2d(16), atlas);
      await upload(r, hd, () => frames(r, s, camera, 1));
      vegetationAtlasSlot(atlas).set(hd);
      atlas.dispose();
      await frames(r, s, camera, 3);
      expect(builds).toBe(0);
      expect(near.map).toBe(hd);
      expect(boundInDraws(r, hd)).toBe(true);
      // a kind first made after the swap draws the HD atlas too
      expect(vegetationMaterial(kindB, atlas).map).toBe(hd);
    });
  });
}

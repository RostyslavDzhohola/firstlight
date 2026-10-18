import { beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { STARTER_LOOKS, STARTERS, WEAPONS } from "@firstlight/shared/content/weapons";
import { ANIM } from "@firstlight/shared/net/schema";
import { watchDisposals } from "./disposeWatch.testutil.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let mod: typeof import("./Avatars.ts");
let weapons: typeof import("./avatars/weapons.ts");
beforeAll(async () => {
  mod = await import("./Avatars.ts");
  weapons = await import("./avatars/weapons.ts");
});

const R = 1000;
/** A point on a planet of radius R, `east` metres along the tangent from the north pole. */
const at = (east: number) => new THREE.Vector3(east, R, 0).normalize().multiplyScalar(R);

describe("AvatarView ground speed", () => {
  it("is measured per avatar, not from whichever avatar moved last", () => {
    const runner = new mod.AvatarView(0, 0);
    const idler = new mod.AvatarView(1, 1);
    const dt = 1 / 30;
    for (let i = 0; i < 60; i++) {
      const p = at(i * 6 * dt); // 6 m/s
      runner.set(p.x, p.y, p.z, 1, 0, 0, ANIM.RUN, dt);
      const q = at(-50); // stands still, far away
      idler.set(q.x, q.y, q.z, 1, 0, 0, ANIM.IDLE, dt);
    }
    expect(runner.groundSpeed).toBeGreaterThan(5.5);
    expect(runner.groundSpeed).toBeLessThan(6.5);
    expect(idler.groundSpeed).toBeLessThan(0.01);
    runner.dispose();
    idler.dispose();
  });
});

describe("avatar teardown", () => {
  it("disposes cloned skeletons and per-object render state, never shared geometry or materials", () => {
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    const bone = new THREE.Bone();
    const skel = new THREE.Skeleton([bone]);
    const skinned = new THREE.SkinnedMesh(geo, mat);
    skinned.add(bone);
    skinned.bind(skel);
    const prop = new THREE.Mesh(geo, mat);
    const root = new THREE.Group().add(skinned, prop);

    const skelDispose = vi.spyOn(skel, "dispose");
    const objectEvents: string[] = [];
    skinned.addEventListener("dispose", () => objectEvents.push("skinned"));
    prop.addEventListener("dispose", () => objectEvents.push("prop"));
    let sharedDisposed = 0;
    geo.addEventListener("dispose", () => sharedDisposed++);
    mat.addEventListener("dispose", () => sharedDisposed++);

    mod.releaseAvatarObjects(root);
    expect(skelDispose).toHaveBeenCalledTimes(1);
    expect(objectEvents.sort()).toEqual(["prop", "skinned"]);
    expect(sharedDisposed).toBe(0);
  });

  it("releases its capsule on dispose and leaves the LOD registry", () => {
    const a = new mod.AvatarView(2, 3);
    const events: number[] = [];
    a.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.addEventListener("dispose", () => events.push(1)); });
    expect(mod.AvatarView.all.has(a)).toBe(true);
    a.dispose();
    expect(events.length).toBeGreaterThan(0);
    expect(mod.AvatarView.all.has(a)).toBe(false);
  });
});

describe("held items", () => {
  it("builds a model for every weapon id except fists and hidden specials", () => {
    for (const w of WEAPONS) {
      const m = weapons.weaponModel(w.id, 0);
      if (w.id === "fists" || w.hidden) expect(m).toBeNull();
      else {
        expect(m, w.id).not.toBeNull();
        let meshes = 0;
        m!.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
        expect(meshes, w.id).toBeGreaterThan(0);
        expect(meshes, `${w.id} draw calls`).toBeLessThanOrEqual(6);
      }
    }
  });

  it("shares geometry between copies of the same item", () => {
    const a = weapons.weaponModel("carbine", 1)!;
    const b = weapons.weaponModel("carbine", 1)!;
    expect((a.children[0] as THREE.Mesh).geometry).toBe((b.children[0] as THREE.Mesh).geometry);
  });

  it("holds guns muzzle-along-the-knuckles, top towards the thumb", () => {
    const muzzle = new THREE.Vector3(0, 0, 1).applyQuaternion(mod.GUN_GRIP);
    const top = new THREE.Vector3(0, 1, 0).applyQuaternion(mod.GUN_GRIP);
    expect(muzzle.distanceTo(new THREE.Vector3(-1, 0, 0))).toBeLessThan(1e-6);
    expect(top.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-6);
  });
});

describe("avatar warm-up hook", () => {
  it("stands every starter's every look in every palette (T9: each material in play compiles behind the loading screen)", () => {
    const looks = mod.avatarWarmupLooks();
    const n = STARTER_LOOKS.flat().length; // 5 starters + the second looks of Kappa and Unit 7
    expect(n).toBe(7);
    expect(looks).toHaveLength(n * mod.PALETTES.length);
    expect(new Set(looks.map((l) => `${l.starter}:${l.look}:${l.palette}`)).size).toBe(n * mod.PALETTES.length);
    // every starter weapon is held by some sample (the line-up's kunai compiled in play before)
    for (const s of STARTERS) expect(looks.some((l) => l.item === s.weapon), s.weapon).toBe(true);
  });

  it("keeps its samples for the session: in the scene (hidden) while warming, out of it after, never disposed", () => {
    const scene = new THREE.Scene();
    const before = mod.AvatarView.all.size;
    const hook = mod.avatarWarmupHook(scene, () => at(0));
    hook.forceAll(true);
    const kept = scene.getObjectByName("avatarWarmup")!;
    expect(kept).toBeTruthy();
    expect(kept.visible).toBe(false); // warmup() shows hidden objects while it runs
    // One avatar per starter and palette, and one far-LOD capsule per palette.
    expect(kept.children).toHaveLength(mod.avatarWarmupLooks().length + mod.PALETTES.length);
    expect(mod.AvatarView.all.size).toBe(before); // never ranked by the LOD pass
    const w = watchDisposals(kept);
    hook.forceAll(false);
    hook.forceAll(false);
    expect(kept.parent).toBeNull(); // no per-frame cost in play
    expect(w.disposed.size).toBe(0); // three keeps the builds while the render objects live
    // The next warm-up (travel, graphics change) brings the same samples to its scene and spot.
    const other = new THREE.Scene();
    mod.avatarWarmupHook(other, () => at(50)).forceAll(true);
    expect(other.getObjectByName("avatarWarmup")).toBe(kept);
    expect(kept.children).toHaveLength(mod.avatarWarmupLooks().length + mod.PALETTES.length);
    for (const c of kept.children) expect(c.position.distanceTo(at(50))).toBeLessThan(1e-6);
    expect(w.disposed.size).toBe(0);
  });
});

describe("looks → models", () => {
  it("draws every look with its own model; the originals come first, in starter order", async () => {
    const { MODEL_FILES, MODEL_SCALE, modelIndex } = await import("./avatars/assets.ts");
    STARTER_LOOKS.forEach((ls, s) => ls.forEach((l, k) => expect(MODEL_FILES[modelIndex(s, k)]).toBe(l.id)));
    STARTERS.forEach((st, s) => expect(MODEL_FILES[s]).toBe(st.id));
    expect(MODEL_FILES).toHaveLength(STARTER_LOOKS.flat().length);
    expect(MODEL_SCALE).toHaveLength(MODEL_FILES.length);
    expect(modelIndex(2, 1)).toBe(MODEL_FILES.indexOf("kappa_b"));
    expect(modelIndex(0, 1)).toBe(0); // Hexwick has no second look: the original
    expect(modelIndex(3, 7)).toBe(3);
  });

  it("rescales only the pelvis track for shorter legs", async () => {
    const { legClips, UAL_PELVIS } = await import("./avatars/assets.ts");
    const pos = new THREE.VectorKeyframeTrack("pelvis.position", [0, 1], [0, UAL_PELVIS, -0.05, 0, UAL_PELVIS - 0.1, -0.05]);
    const rot = new THREE.QuaternionKeyframeTrack("spine_01.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
    const src = new Map([["walk", new THREE.AnimationClip("walk", 1, [pos, rot])]]);
    const out = legClips(src, UAL_PELVIS / 2).get("walk")!;
    expect(Array.from(out.tracks[0]!.values)).toEqual([0, UAL_PELVIS / 2, -0.025, 0, (UAL_PELVIS - 0.1) / 2, -0.025].map((v) => Math.fround(v)));
    expect(out.tracks[1]).toBe(rot); // rotations are shared, not copied
    expect(src.get("walk")!.tracks[0]!.values[1]).toBeCloseTo(UAL_PELVIS); // the shared clip is untouched
  });
});

describe("character textures follow the tier up (D-load-6)", () => {
  /** A stand-in texture of `size`² (named like the file it came from). */
  const tex = (name: string, size: number) => {
    const t = new THREE.Texture({ width: size, height: size } as unknown as HTMLImageElement);
    t.name = name;
    return t;
  };
  /** Every TextureNode in a material's node graph. */
  function textureNodes(m: THREE.Material): { value: THREE.Texture }[] {
    const seen = new Set<unknown>();
    const found: { value: THREE.Texture }[] = [];
    const visit = (n: unknown) => {
      if (!n || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      const node = n as { isNode?: boolean; isTextureNode?: boolean; getChildren?: () => Iterable<unknown> };
      if (!node.isNode) return;
      if (node.isTextureNode) found.push(n as { value: THREE.Texture });
      for (const c of node.getChildren?.() ?? []) visit(c);
    };
    const nm = m as unknown as Record<string, unknown>;
    for (const k of ["colorNode", "normalNode", "emissiveNode"]) visit(nm[k]);
    return found;
  }

  it("a session that started on Low swaps its 512² textures for 1024² ones in the same materials (no new shader builds)", async () => {
    const { MODEL_FILES, STARTER_FILES, flatNormalMap, raiseTextures } = await import("./avatars/assets.ts");
    const { avatarMaterial } = await import("./avatars/material.ts");
    const own = (i: number) => i < STARTER_FILES.length;
    const textures = MODEL_FILES.map((f, i) => ({ albedo: tex(`${f}_albedo_512`, 512), normal: own(i) ? tex(`${f}_normal_512`, 512) : flatNormalMap() }));
    const before = textures.map((t) => ({ ...t }));
    const mats = textures.map((t, i) => avatarMaterial(t, i % 6));
    const versions = mats.map((m) => m.version);
    const released = new Set<THREE.Texture>();
    for (const t of before) for (const x of [t.albedo, t.normal]) x.addEventListener("dispose", () => released.add(x));
    const asked: string[] = [];
    const ok = await raiseTextures({ textures } as never, async (name, srgb) => {
      asked.push(name);
      const t = tex(name, 1024);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return t;
    });
    expect(ok).toBe(true);
    // The full-size files: every look's albedo, the sculpted originals' normal maps (the second looks keep the flat one).
    expect(asked.sort()).toEqual([...MODEL_FILES.map((f) => `${f}_albedo`), ...STARTER_FILES.map((f) => `${f}_normal`)].sort());
    textures.forEach((t, i) => {
      expect((t.albedo.image as { width: number }).width, MODEL_FILES[i]).toBe(1024);
      if (own(i)) expect((t.normal.image as { width: number }).width).toBe(1024);
      else expect(t.normal).toBe(flatNormalMap());
      // Same material, same program: only the bound textures changed.
      expect(avatarMaterial(t, i % 6)).toBe(mats[i]);
      expect(mats[i]!.version).toBe(versions[i]);
      const bound = textureNodes(mats[i]!).map((n) => n.value);
      expect(bound).toContain(t.albedo);
      expect(bound).not.toContain(before[i]!.albedo);
      if (own(i)) expect(bound).toContain(t.normal);
    });
    expect(released.size, "the 512² textures are released").toBe(MODEL_FILES.length + STARTER_FILES.length);
    expect(released.has(flatNormalMap())).toBe(false);
  });

  it("keeps the 512² textures when the full-size download fails", async () => {
    const { MODEL_FILES, raiseTextures } = await import("./avatars/assets.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const textures = MODEL_FILES.map((f) => ({ albedo: tex(`${f}_albedo_512`, 512), normal: tex(`${f}_normal_512`, 512) }));
      const before = textures.map((t) => ({ ...t }));
      let n = 0;
      const ok = await raiseTextures({ textures } as never, async (name) => {
        if (++n === 3) throw new Error("offline");
        return tex(name, 1024);
      });
      expect(ok).toBe(false);
      textures.forEach((t, i) => expect(t).toEqual(before[i]));
    } finally {
      warn.mockRestore();
    }
  });

  it("only a session whose textures are 512² reloads, and only for a tier above Low", async () => {
    const { avatarTexturesFollowTier } = await import("./avatars/assets.ts");
    let loads = 0;
    const raise = async () => {
      loads++;
      return true;
    };
    expect(await avatarTexturesFollowTier("medium", { lowRes: false, raise })).toBe(false); // started at 1024²
    expect(await avatarTexturesFollowTier("low", { lowRes: true, raise })).toBe(false); // still on Low
    expect(loads).toBe(0);
    expect(await avatarTexturesFollowTier("high", { lowRes: true, raise })).toBe(true);
    expect(loads).toBe(1);
  });
});

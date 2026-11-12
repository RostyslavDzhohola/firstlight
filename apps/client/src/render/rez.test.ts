import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { castsLeanShadow, leanShadow } from "./leanShadow.ts";
import { applyOccluderFadeGated, keepsWholeShadow } from "./occluderFade.ts";
import { CUT_GONE, CUT_IDLE, DEATH_HOLD, REZ_FLOOR, REZ_SECONDS, REZ_SHARDS, REZ_TOP, rezBody, rezFxGeometry, rezFxMaterial, rezFxMesh, rezKeep, rezMode, rezPose } from "./rez.ts";

describe("rez timing (rezPose)", () => {
  it("rez-in: nothing of the body at the start, the scan plane climbs from the soles past the head, then the avatar is whole and idle", () => {
    const a = rezPose("in", 0);
    expect(a.cut).toBeCloseTo(REZ_FLOOR);
    expect(a.glow).toBe(1);
    expect(a.solid).toBe(false);
    expect(a.done).toBe(false);
    let last = -Infinity;
    for (let t = 0; t < REZ_SECONDS.in; t += 0.05) {
      const p = rezPose("in", t);
      expect(p.cut).toBeGreaterThanOrEqual(last);
      expect(p.cut).toBeLessThanOrEqual(REZ_TOP + 1e-6);
      expect(p.dissolve).toBe(0);
      last = p.cut;
    }
    expect(last).toBeCloseTo(REZ_TOP, 1);
    const end = rezPose("in", REZ_SECONDS.in);
    expect(end).toMatchObject({ cut: CUT_IDLE, dissolve: 0, glow: 0, solid: true, done: true, fx: 1 });
    expect(rezPose("in", 99)).toMatchObject({ cut: CUT_IDLE, done: true });
  });

  it("rez-in: the shadow and the held item come back once most of the body is there, the glow fades at the end", () => {
    expect(rezPose("in", REZ_SECONDS.in * 0.3).solid).toBe(false);
    expect(rezPose("in", REZ_SECONDS.in * 0.75).solid).toBe(true);
    expect(rezPose("in", REZ_SECONDS.in * 0.8).glow).toBe(1);
    const g = rezPose("in", REZ_SECONDS.in * 0.93).glow;
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(1);
  });

  it("de-rez: the plane comes down from the head, and the avatar ends gone", () => {
    expect(rezPose("out", 0).cut).toBeCloseTo(REZ_TOP);
    expect(rezPose("out", 0).solid).toBe(true);
    const mid = rezPose("out", REZ_SECONDS.out * 0.5);
    expect(mid.cut).toBeLessThan(REZ_TOP);
    expect(mid.cut).toBeGreaterThan(REZ_FLOOR);
    expect(mid.solid).toBe(false);
    expect(rezPose("out", REZ_SECONDS.out)).toMatchObject({ cut: CUT_GONE, done: true });
  });

  it("death: the body falls whole first, then dissolves to nothing and stays gone", () => {
    const hold = rezPose("death", DEATH_HOLD * 0.9);
    expect(hold.dissolve).toBe(0);
    expect(hold.cut).toBe(CUT_IDLE);
    expect(hold.solid).toBe(true);
    let last = 0;
    for (let t = DEATH_HOLD; t < REZ_SECONDS.death; t += 0.05) {
      const p = rezPose("death", t);
      expect(p.dissolve).toBeGreaterThanOrEqual(last);
      expect(p.dissolve).toBeLessThan(1);
      last = p.dissolve;
    }
    expect(last).toBeGreaterThan(0.9);
    expect(rezPose("death", REZ_SECONDS.death)).toMatchObject({ cut: CUT_GONE, dissolve: 1, done: true, solid: false });
  });

  it("reuses the pose it is given (no allocation per frame)", () => {
    const out = rezPose("in", 0);
    expect(rezPose("out", 0.1, out)).toBe(out);
  });
});

describe("rez on the avatar's material", () => {
  it("an idle body's values keep every fragment, and each mesh has its own", () => {
    const a = new THREE.Object3D(), b = new THREE.Object3D();
    const va = rezBody(a);
    expect(va.p.x).toBe(CUT_IDLE);
    expect(va.p.y).toBe(0);
    expect(va.p.z).toBe(0);
    expect(va.feet.length()).toBeGreaterThan(0); // normalize(feet) in the shader: never a zero vector
    expect(rezBody(a)).toBe(va);
    expect(rezBody(b)).not.toBe(va);
  });

  it("the rez mask leaves the shadow mask keep-all: the material still casts a lean shadow (D-load-3)", () => {
    // What avatarMaterial() does, on a bare material.
    const m = leanShadow(applyOccluderFadeGated(new THREE.MeshToonNodeMaterial()));
    m.maskNode = (rezKeep() as unknown as { and(b: THREE.Node): THREE.Node }).and(m.maskNode!);
    expect(keepsWholeShadow(m.maskShadowNode)).toBe(true);
    expect(castsLeanShadow(m)).toBe(true);
    expect(rezKeep()).toBe(rezKeep()); // one node for every look
  });
});

describe("the rez light", () => {
  it("is one shared geometry and one shared additive material, whatever the avatar", () => {
    const a = rezFxMesh(), b = rezFxMesh();
    expect(a.mesh.geometry).toBe(b.mesh.geometry);
    expect(a.mesh.material).toBe(b.mesh.material);
    expect(a.fx).not.toBe(b.fx);
    expect(a.mesh.visible).toBe(false);
    const m = rezFxMaterial();
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(a.fx.p.w).toBe(0); // dark until an effect runs
  });

  it("holds the column, both rings and every shard in one indexed geometry", () => {
    const g = rezFxGeometry();
    const kinds = g.getAttribute("aFx");
    const seen = new Map<number, number>();
    for (let i = 0; i < kinds.count; i++) seen.set(kinds.getX(i), (seen.get(kinds.getX(i)) ?? 0) + 1);
    expect([...seen.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect(seen.get(3)).toBe(REZ_SHARDS * 3);
    expect(g.getAttribute("aCenter").count).toBe(kinds.count);
    expect(g.getIndex()!.count % 3).toBe(0);
    expect(rezFxGeometry()).toBe(g);
  });

  it("names the three effects for the shader", () => {
    expect([rezMode("in"), rezMode("out"), rezMode("death")]).toEqual([0, 1, 2]);
  });
});

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { LOOKS } from "./looks.ts";
import { emptyStored, resolveSettings } from "./quality.ts";
import { AURORA, auroraGeometry, frameDir, lanePoint, SHOOTING_STARS, skyLanes, SkyLife, skyTrafficGeometry, TRAIL_HALF } from "./skyLife.ts";

const specs = LOOKS.portus.skyPlanets;
const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
const angle = (a: readonly number[], b: readonly number[]) => Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));

describe("sky traffic lanes", () => {
  it("runs one lane between each pair of sky planets and one from each down to the horizon", () => {
    const lanes = skyLanes(specs);
    const n = specs.length;
    expect(lanes).toHaveLength((n * (n - 1)) / 2 + n);
    const down = lanes.filter((l) => l.to[1] < 0);
    expect(down).toHaveLength(n);
    for (const l of lanes) {
      expect(len(l.from)).toBeCloseTo(1);
      expect(len(l.to)).toBeCloseTo(1);
    }
  });

  it("starts and ends at its planets, stays on the unit sphere and arcs above the straight line", () => {
    for (const l of skyLanes(specs)) {
      expect(angle(lanePoint(l, 0), l.from)).toBeCloseTo(0, 5);
      expect(angle(lanePoint(l, 1), l.to)).toBeCloseTo(0, 5);
      const mid = lanePoint(l, 0.5);
      expect(len(mid)).toBeCloseTo(1);
      const flat = lanePoint({ ...l, lift: 0 }, 0.5);
      expect(mid[1]).toBeGreaterThan(flat[1]);
    }
  });

  it("leaves the planets' discs clear: a lane's drawn part begins outside them", () => {
    const lanes = skyLanes(specs);
    specs.forEach((s) => {
      const d = frameDir(s.elevDeg, s.azDeg);
      for (const l of lanes) {
        if (angle(l.from, d) < 1e-6) expect(angle(lanePoint(l, l.trim[0]), d)).toBeGreaterThan((s.sizeDeg * Math.PI) / 180 * 0.9);
        if (angle(l.to, d) < 1e-6) expect(angle(lanePoint(l, 1 - l.trim[1]), d)).toBeGreaterThan((s.sizeDeg * Math.PI) / 180 * 0.9);
      }
    });
  });

  it("builds every lane and shooting star into one thin-ribbon geometry, the same each time", () => {
    const g = skyTrafficGeometry(specs);
    const kinds = g.getAttribute("aLane");
    let stars = 0;
    for (let i = 0; i < kinds.count; i++) if (kinds.getX(i) === 1) stars++;
    expect(stars).toBe(SHOOTING_STARS * 7 * 2); // 6 segments: 7 pairs of vertices each
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i += 17) expect(Math.abs(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) - 1)).toBeLessThan(TRAIL_HALF * 2);
    expect(Array.from(skyTrafficGeometry(specs).getAttribute("position").array)).toEqual(Array.from(p.array));
    // Each shooting star keeps its own period: never a volley.
    const periods = new Set<number>();
    for (let i = 0; i < kinds.count; i++) if (kinds.getX(i) === 1) periods.add(kinds.getZ(i));
    expect(periods.size).toBe(SHOOTING_STARS);
    for (const s of periods) expect(s).toBeGreaterThanOrEqual(45);
  });

  it("the aurora is a low band of the sky, above the horizon", () => {
    const p = auroraGeometry().getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i)).toBeGreaterThan(Math.sin((AURORA.elev0 * Math.PI) / 180) - 1e-6);
      expect(p.getY(i)).toBeLessThan(Math.sin((AURORA.elev1 * Math.PI) / 180) + 1e-6);
    }
  });
});

describe("sky life in the scene", () => {
  const settings = (tier: "low" | "medium" | "high", kills: string[] = []) => resolveSettings(tier, false, true, emptyStored(), new Set(kills) as never);

  it("is two additive draws: trails from Medium, the aurora from High; none on Low or with ?noskylife", () => {
    const scene = new THREE.Scene();
    const sky = new SkyLife(scene, specs, "portus");
    expect(scene.children).toHaveLength(2);
    for (const m of [sky.traffic, sky.aurora]) {
      const mat = m.material as THREE.Material;
      expect(mat.blending).toBe(THREE.AdditiveBlending);
      expect(mat.depthWrite).toBe(false);
    }
    sky.applySettings(settings("low"));
    expect([sky.traffic.visible, sky.aurora.visible]).toEqual([false, false]);
    sky.applySettings(settings("medium"));
    expect([sky.traffic.visible, sky.aurora.visible]).toEqual([true, false]);
    sky.applySettings(settings("high"));
    expect([sky.traffic.visible, sky.aurora.visible]).toEqual([true, true]);
    sky.applySettings(settings("high", ["skylife"]));
    expect([sky.traffic.visible, sky.aurora.visible]).toEqual([false, false]);
    sky.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("another body re-lays the lanes without a new material", () => {
    const scene = new THREE.Scene();
    const sky = new SkyLife(scene, specs, "portus");
    const mat = sky.traffic.material, geo = sky.traffic.geometry;
    sky.setBody(LOOKS.arcadia.skyPlanets, "arcadia");
    expect(sky.traffic.material).toBe(mat);
    expect(sky.traffic.geometry).not.toBe(geo);
    sky.dispose();
  });

  it("a frame places both meshes on the camera in the local sky frame (up = the frame's y)", () => {
    const scene = new THREE.Scene();
    const sky = new SkyLife(scene, specs, "portus");
    sky.applySettings(settings("high"));
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(10, 600, -20);
    sky.update(cam);
    const e = sky.traffic.matrix.elements;
    expect([e[12], e[13], e[14]]).toEqual([10, 600, -20]);
    const up = new THREE.Vector3(e[4], e[5], e[6]).normalize(); // the frame's y axis: atmo.up
    expect(up.length()).toBeCloseTo(1);
    expect(Array.from(sky.aurora.matrix.elements)).toEqual(Array.from(e));
    sky.dispose();
  });
});

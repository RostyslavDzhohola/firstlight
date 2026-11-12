import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { PILE_BEAM_M, PILE_BEAM_R, PILE_BEAM_WIDEN, PILE_FAR_M, PILE_RING_M, PILE_SPARKS, pileBeaconGeometry, pileBeaconMaterial, pileBeamWiden } from "./pileBeacon.ts";

describe("the loot pile's beacon", () => {
  it("is a tall shaft, a ground ring and sparks in one small indexed geometry", () => {
    const g = pileBeaconGeometry();
    const kinds = g.getAttribute("aPart"), pos = g.getAttribute("position");
    const seen = new Map<number, number>();
    let top = 0, reach = 0;
    for (let i = 0; i < kinds.count; i++) {
      const k = kinds.getX(i);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (k === 0) top = Math.max(top, pos.getY(i));
      if (k === 1) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    expect([...seen.keys()].sort()).toEqual([0, 1, 2]);
    expect(seen.get(2)).toBe(PILE_SPARKS * 4);
    expect(top).toBe(PILE_BEAM_M);
    expect(top).toBeGreaterThan(25); // taller than Portus' houses: it clears roofs and trees
    expect(reach).toBeCloseTo(PILE_RING_M, 5);
    expect(g.getIndex()!.count / 3).toBeLessThan(150);
    expect(pileBeaconGeometry()).toBe(g);
    // Bounds cover the shaft at its widest, so it is never culled while on screen.
    expect(g.boundingSphere!.radius).toBeGreaterThan(PILE_BEAM_M / 2);
  });

  it("reads from 60 m: the shaft is drawn wider with distance", () => {
    expect(pileBeamWiden(5)).toBe(1);
    expect(pileBeamWiden(14)).toBe(1);
    expect(pileBeamWiden(PILE_FAR_M)).toBeCloseTo(PILE_BEAM_WIDEN, 5);
    expect(pileBeamWiden(300)).toBeCloseTo(PILE_BEAM_WIDEN, 5);
    // At 60 m on a 720-line screen with a 60° field of view, the shaft's foot is over 20 px wide.
    const px = (2 * PILE_BEAM_R * pileBeamWiden(60) * 720) / (2 * 60 * Math.tan((30 * Math.PI) / 180));
    expect(px).toBeGreaterThan(20);
  });

  it("is one additive, single-pass material", () => {
    const m = pileBeaconMaterial();
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(m.forceSinglePass).toBe(true);
    expect(pileBeaconMaterial()).toBe(m);
  });
});

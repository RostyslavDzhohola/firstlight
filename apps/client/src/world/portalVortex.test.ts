import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { emptyStored, resolveSettings, type Feature } from "../render/quality.ts";
import { BEAM_HEIGHT, beamMaterial, PULSE_SECONDS, vortexEdge, vortexMaterial } from "./portalVortex.ts";
import { PORTAL_GATES } from "./Portals.ts";

describe("the portal vortex", () => {
  it("measures the arch's opening: positive inside, zero on the jambs, floor and crown, negative outside", () => {
    const g = PORTAL_GATES.portus;
    const arch = { kind: "arch", base: g.base, spring: g.spring, half: g.half } as const;
    expect(vortexEdge(arch, 0, (g.base + g.spring) / 2)).toBeCloseTo(g.half);
    expect(vortexEdge(arch, g.half, 2)).toBeCloseTo(0);
    expect(vortexEdge(arch, 0, g.base)).toBeCloseTo(0);
    expect(vortexEdge(arch, 0, g.spring + g.half)).toBeCloseTo(0);
    expect(vortexEdge(arch, g.half + 0.5, 2)).toBeLessThan(0);
    expect(vortexEdge({ kind: "disc", radius: 2 }, 0, 0)).toBe(2);
    expect(vortexEdge({ kind: "disc", radius: 2 }, 2, 0)).toBeCloseTo(0);
  });

  it("is one unlit, depth-tested, non-writing material per portal, with no pulse until someone passes", () => {
    const v = vortexMaterial("arcadia", 0x36f9f6, { kind: "disc", radius: 2.05 });
    expect(v.material.transparent).toBe(true);
    expect(v.material.depthWrite).toBe(false);
    expect(v.material.side).toBe(THREE.DoubleSide);
    expect(v.pulseAge.value).toBe(PULSE_SECONDS);
    const w = vortexMaterial("meridian", 0xff7a4a, { kind: "arch", base: 0.2, spring: 5.06, half: 1.93 });
    expect(w.pulseAge).not.toBe(v.pulseAge); // each portal pulses on its own
  });

  it("the pad beam is additive and fog-free, tall enough to read from the wild", () => {
    const m = beamMaterial(0x72f1b8);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(BEAM_HEIGHT).toBeGreaterThan(150);
  });
});

describe("the hub lane's feature switches", () => {
  const on = (tier: "low" | "medium" | "high", kills: Feature[] = []) => resolveSettings(tier, false, true, emptyStored(), new Set(kills)).on;

  it("are all on from Medium up; Low keeps the plain portals and an empty sky, but still rezzes and shows the board", () => {
    for (const t of ["medium", "high"] as const) expect([on(t).rez, on(t).portalfx, on(t).holo, on(t).skylife, on(t).pools]).toEqual([true, true, true, true, true]);
    expect([on("low").rez, on("low").portalfx, on("low").holo, on("low").skylife, on("low").pools]).toEqual([true, false, true, false, false]);
  });

  it("each has its own kill switch, and the sky's extras go with the sky", () => {
    const mine = ["rez", "portalfx", "holo", "skylife", "pools"] as const;
    for (const f of mine) {
      const s = on("high", [f]);
      expect(s[f]).toBe(false);
      for (const g of mine) if (g !== f) expect(s[g]).toBe(true);
    }
    expect(on("high", ["sky"]).skylife).toBe(false);
  });
});

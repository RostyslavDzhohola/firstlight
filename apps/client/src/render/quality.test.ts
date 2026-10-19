// Medium's measured extras (#49, D-framerate-3): High features a device's probe found GPU headroom for,
// applied on top of the automatic tier; stored with it for the same backend and GPU.

import { describe, expect, it } from "vitest";
import { EXTRAS, emptyStored, parseStored, resolveSettings, TIER_TABLE, validAutoExtras, withExtras, type StoredGfx } from "./quality.ts";

const kills = new Set<never>();

describe("withExtras", () => {
  it("takes each extra's High values and leaves the rest of the tier alone", () => {
    const m = TIER_TABLE.medium;
    const s = withExtras(m, ["normals", "water2"]);
    expect(s.terrain).toEqual({ ...m.terrain, detailLayers: 4, normals: true });
    expect(s.water).toBe(2);
    expect(s.grass).toEqual(m.grass);
    expect(s.shadows).toEqual(m.shadows);
    expect(s.dprCap).toBe(m.dprCap);
    expect(s.renderScale).toBe(m.renderScale);
    expect(s.gpuTargetMs).toBe(m.gpuTargetMs); // Medium's budget, not High's
    expect(m.terrain.normals).toBe(false); // the table itself is untouched
  });

  it("gives every extra High's own value", () => {
    const h = TIER_TABLE.high;
    const s = withExtras(TIER_TABLE.medium, EXTRAS);
    expect(s.terrain).toEqual(h.terrain);
    expect(s.sky.planetAtmospheres).toBe(true);
    expect(s.water).toBe(h.water);
    expect([s.shadows.mapSize, s.shadows.extent, s.shadows.far]).toEqual([h.shadows.mapSize, h.shadows.extent, h.shadows.far]);
    expect(s.shadows.cascadeSize).toBe(0);
    expect(s.grass).toEqual(h.grass);
    expect(s.props).toEqual(h.props);
    expect(s.post.ao).toBe("half");
  });

  it("never lowers a tier that already has more, and gives Low's blob shadows no map", () => {
    expect(withExtras(TIER_TABLE.ultra, EXTRAS)).toEqual(TIER_TABLE.ultra);
    expect(withExtras(TIER_TABLE.low, ["shadows"]).shadows).toEqual(TIER_TABLE.low.shadows);
  });
});

describe("resolveSettings with extras", () => {
  const stored = (extra: Partial<StoredGfx> = {}): StoredGfx => ({ ...emptyStored(), ...extra });

  it("applies the extras on the automatic tier and lists them", () => {
    const r = resolveSettings("medium", true, true, stored(), kills, ["normals", "ao"]);
    expect(r.extras).toEqual(["normals", "ao"]);
    expect(r.terrain.normals).toBe(true);
    expect(r.on.ao).toBe(true); // GTAO half on Medium, WebGPU
    expect(resolveSettings("medium", true, false, stored(), kills, ["ao"]).on.ao).toBe(false); // WebGPU-only
    expect(resolveSettings("medium", true, true, stored(), kills).extras).toEqual([]);
    expect(resolveSettings("medium", true, true, stored(), kills).on.ao).toBe(false);
  });

  it("the user's own toggles and the kill switches still win", () => {
    const r = resolveSettings("medium", true, true, stored({ features: { ao: false } }), new Set(["detail"] as const), ["ao", "normals"]);
    expect(r.on.ao).toBe(false);
    expect(r.on.detail).toBe(false);
  });
});

describe("stored extras", () => {
  it("are valid only with the automatic tier's backend and GPU", () => {
    const s = parseStored(JSON.stringify({ v: 1, tier: null, autoTier: "medium", autoBackend: "webgpu", autoGpu: "apple m1", autoExtras: ["normals", "bogus", "water2"], features: {} }));
    expect(s.autoExtras).toEqual(["normals", "water2"]);
    expect(validAutoExtras(s, "webgpu", "apple m1")).toEqual(["normals", "water2"]);
    expect(validAutoExtras(s, "webgl2", "apple m1")).toEqual([]);
    expect(validAutoExtras({ ...s, autoTier: null }, "webgpu", "apple m1")).toEqual([]);
  });

  it("older settings without extras parse to none", () => {
    const s = parseStored(JSON.stringify({ v: 1, tier: null, autoTier: "medium", autoBackend: "webgpu", autoGpu: "x", features: {} }));
    expect(s.autoExtras).toBeNull();
    expect(validAutoExtras(s, "webgpu", "x")).toEqual([]);
  });
});

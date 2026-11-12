import { describe, expect, it } from "vitest";
import { GPU_PACK_BUDGET_BYTES, PACK_TIERS, packGroups, packsFor, parsePackFlag, textureGpuBytes, wantedGroups, type PackManifest } from "./catalog.ts";

const manifest: PackManifest = {
  version: 1,
  files: {
    "portus/portus_color.webp": { pack: "town", group: "town:portus", file: "town/portus_color.webp", bytes: 10, sha256: "a", baseSha256: "b", width: 2048, height: 8192, layerSize: 1024, layers: 16, cols: 2 },
    "portus/portus_normal.webp": { pack: "town", group: "town:portus", file: "town/portus_normal.webp", bytes: 10, sha256: "a", baseSha256: "b", width: 2048, height: 8192, layerSize: 1024, layers: 16, cols: 2 },
    "characters/ash_albedo.webp": { pack: "chars", group: "chars:ash", file: "chars/ash_albedo.webp", bytes: 10, sha256: "a", baseSha256: "b", width: 2048, height: 2048 },
  },
};

describe("art packs: who gets which pack", () => {
  it("Low never takes a pack; every pack's tiers are a contiguous run up to Ultra", () => {
    for (const [id, tiers] of Object.entries(PACK_TIERS)) {
      expect(tiers, id).not.toContain("low");
      if (tiers.length) expect(tiers.at(-1), id).toBe("ultra");
      const order = ["low", "medium", "high", "ultra"];
      const idx = tiers.map((t) => order.indexOf(t));
      idx.forEach((v, i) => i && expect(v, id).toBe(idx[i - 1]! + 1));
    }
    expect(packsFor("low", { mode: "auto" })).toEqual([]);
  });

  it("follows the tier table, and the URL can force them on (any tier but Low) or off", () => {
    for (const tier of ["medium", "high", "ultra"] as const) {
      expect(packsFor(tier, { mode: "auto" })).toEqual(Object.entries(PACK_TIERS).filter(([, t]) => t.includes(tier)).map(([id]) => id));
      expect(packsFor(tier, { mode: "off" })).toEqual([]);
      expect(packsFor(tier, { mode: "on" })).toEqual(Object.keys(PACK_TIERS));
      expect(packsFor(tier, { mode: "on", only: ["chars"] })).toEqual(["chars"]);
    }
    expect(packsFor("low", { mode: "on" })).toEqual([]);
  });

  it("reads ?packs / ?nopacks", () => {
    expect(parsePackFlag(null, false)).toEqual({ mode: "auto" });
    expect(parsePackFlag(null, true)).toEqual({ mode: "off" });
    expect(parsePackFlag("off", false)).toEqual({ mode: "off" });
    expect(parsePackFlag("", false)).toEqual({ mode: "on" });
    expect(parsePackFlag("on", false)).toEqual({ mode: "on" });
    expect(parsePackFlag("town,vegetation,bogus", false)).toEqual({ mode: "on", only: ["town", "vegetation"] });
    expect(parsePackFlag("on", true)).toEqual({ mode: "off" }); // the kill switch wins
  });

  it("groups a manifest's files by swap group, and picks the groups of the wanted packs", () => {
    const g = packGroups(manifest);
    expect([...g.keys()]).toEqual(["town:portus", "chars:ash"]);
    expect(g.get("town:portus")!.map((f) => f.base)).toEqual(["portus/portus_color.webp", "portus/portus_normal.webp"]);
    expect(wantedGroups(manifest, ["chars"]).map((x) => x.group)).toEqual(["chars:ash"]);
    expect(wantedGroups(manifest, [])).toEqual([]);
  });

  it("estimates GPU bytes with the mip chain (4/3), per layer for strips", () => {
    expect(textureGpuBytes({ width: 2048, height: 2048 })).toBe(Math.round(2048 * 2048 * 4 * 4 / 3));
    expect(textureGpuBytes({ width: 2048, height: 8192, layerSize: 1024, layers: 16, cols: 2 })).toBe(Math.round(1024 * 1024 * 4 * 16 * 4 / 3));
    expect(GPU_PACK_BUDGET_BYTES).toBeGreaterThan(0);
  });
});

// The shipped structure sites (D38, D42): the Portus town and the three pad outposts. Manifests,
// sizes, hashes and a full decode of each meshopt GLB in Node (no DOM image decoder needed: the GLBs
// have no textures; the WebP strips are checked by header); the outposts' slots and look.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PORTUS_TOWN_VERSION, TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { OUTPOSTS } from "@firstlight/shared/content/padOutposts";
import { loadSite, loadTown, resolveAsset, validateTown } from "./townAssets.ts";
import { siteBytes, siteDir, siteManifest, testSiteAssets, testTownAssets, townBytes as bytes, townDir as dir, townManifest as manifest } from "./townAssets.testutil.ts";

/** Width and height of a WebP file (VP8, VP8L or VP8X header). */
function webpSize(b: Buffer): [number, number] {
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  expect(b.toString("ascii", 8, 12)).toBe("WEBP");
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  const bits = b.readUInt32LE(21);
  return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
}

describe("town asset download", () => {
  it("aborts every request and rejects when the answer never comes (review S1)", async () => {
    const aborted: string[] = [];
    const hang = (url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => {
        aborted.push(url);
        reject(init.signal.reason);
      }));
    const t0 = Date.now();
    await expect(loadTown(hang, 40)).rejects.toThrow(/no answer in 40 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(aborted).toEqual([expect.stringMatching(/manifest\.json$/)]);
  });

  it("rejects a manifest from another layout version", async () => {
    const stale = async () => new Response(JSON.stringify({ ...manifest, version: "0000000000000000" }));
    await expect(loadTown(stale, 1000)).rejects.toThrow(/does not match the layout/);
    const arcadia = siteManifest("arcadia");
    await expect(loadSite("arcadia", async () => new Response(JSON.stringify({ ...arcadia, version: PORTUS_TOWN_VERSION })), 1000)).rejects.toThrow(/does not match the layout/);
  });

  it("resolves an outpost's files from its folder, the shared Portus strips included", async () => {
    expect(resolveAsset("/assets-dev/outposts/arcadia/", "../../portus/portus_color.webp")).toBe("/assets-dev/portus/portus_color.webp");
    expect(resolveAsset("/assets-dev/outposts/meridian/", "meridian.glb")).toBe("/assets-dev/outposts/meridian/meridian.glb");
    expect(resolveAsset("https://cdn.example/a/outposts/hollowmere/", "../../portus/x.webp")).toBe("https://cdn.example/a/portus/x.webp");
    expect(resolveAsset("/assets-dev/portus/", "/other/abs.webp")).toBe("/other/abs.webp");
    // The real loader asks for exactly those URLs (here every file but the manifest fails).
    const asked: string[] = [];
    const m = siteManifest("hollowmere");
    const fake = async (url: string) => {
      asked.push(url);
      return url.endsWith("manifest.json") ? new Response(JSON.stringify(m)) : new Response("", { status: 404 });
    };
    await expect(loadSite("hollowmere", fake, 1000)).rejects.toThrow(/404/);
    expect(asked).toContain("/assets-dev/outposts/hollowmere/manifest.json");
    expect(asked).toContain("/assets-dev/outposts/hollowmere/hollowmere.glb");
    expect(asked.some((u) => u === "/assets-dev/portus/portus_color.webp" || u === "/assets-dev/portus/portus_normal.webp")).toBe(true);
  });
});

describe.each(["arcadia", "hollowmere", "meridian"] as const)("shipped %s pad outpost (D42)", (body) => {
  const m = siteManifest(body);
  const site = OUTPOSTS[body];

  it("matches the shared layout version, its files' sizes and hashes, and stays under 2 MB of its own", () => {
    expect(m.version).toBe(site.version);
    expect(m.items).toBe(site.layout.length);
    let own = 0;
    for (const f of Object.values(m.files)) {
      const b = siteBytes(body, f.name);
      expect(b.length, f.name).toBe(f.bytes);
      expect(createHash("sha256").update(b).digest("hex"), f.name).toBe(f.sha256);
      if (!f.name.includes("/portus/")) own += b.length;
    }
    own += statSync(new URL("manifest.json", siteDir(body))).size;
    expect(own).toBeLessThanOrEqual(2_000_000);
    // Arcadia and Hollowmere use the Portus kit's strips (the very files Portus ships); Meridian its own.
    const sharesPortus = body !== "meridian";
    expect(m.files.color.name.startsWith("../../portus/")).toBe(sharesPortus);
    if (sharesPortus) {
      expect(m.files.color.sha256).toBe(manifest.files.color.sha256);
      expect(m.files.normal.sha256).toBe(manifest.files.normal.sha256);
      expect(m.layers).toEqual(manifest.layers);
    } else {
      for (const f of [m.files.color, m.files.normal]) expect(webpSize(siteBytes(body, f.name)), f.name).toEqual([m.layerSize, m.layerSize * m.layers.length]);
    }
    for (const sl of m.slots) expect(sl.layer).toBeLessThan(m.layers.length);
  });

  it("is a meshopt GLB with the two town materials and one node per prefab and LOD", () => {
    const b = siteBytes(body, m.files.glb.name);
    const doc = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
    expect(doc.extensionsRequired).toContain("EXT_meshopt_compression");
    for (const mat of doc.materials) expect(["town_cutout", "town_opaque"]).toContain(mat.name);
    expect(doc.images ?? []).toEqual([]);
    const names = new Set(doc.nodes.map((n: { name: string }) => n.name));
    for (const p of site.prefabs) {
      expect(names.has(p.name), p.name).toBe(true);
      expect(names.has(`${p.name}__L1`), `${p.name}__L1`).toBe(p.tris[1] > 0);
    }
  });

  it("decodes to the layout's prefabs with the expected triangle counts, and has a slot for every path", async () => {
    const { meshes } = await testSiteAssets(body);
    expect(() => validateTown(meshes, m, site.prefabs)).not.toThrow();
    expect(() => validateTown(meshes, m)).toThrow(); // not Portus' prefabs
    expect(site.layout.reduce((s, it) => s + site.prefabs[it[0]]!.tris[0], 0)).toBe(m.trianglesLod0);
    for (const pa of site.paths) expect(m.slots.some((sl) => sl.name === pa.mat), pa.mat).toBe(true);
  });

  it("carries the approved look: glowing lamps, Hollowmere's lit windows and albedo floor, Meridian's darker deck", () => {
    const slot = (name: string) => m.slots.find((sl) => sl.name === name);
    expect((slot("M_GlowTeal")?.glow ?? 0) > 0 || (slot("M_GlowAmber")?.glow ?? 0) > 0).toBe(true);
    if (body === "hollowmere") {
      expect(slot("MI_WindowGlass")!.glow).toBeGreaterThan(0);
      expect(m.look?.albedoFloor).toBeCloseTo(0.045, 5);
    } else expect(m.look?.albedoFloor ?? 0).toBe(0);
    if (body === "meridian") {
      const deck = slot("MI_Trim_03_Deck")!, plain = slot("MI_Trim_03")!;
      const ratio = deck.tint[0] / plain.tint[0];
      expect(ratio).toBeGreaterThanOrEqual(0.8);
      expect(ratio).toBeLessThanOrEqual(0.85);
    }
  });
});

describe("shipped Portus town asset", () => {
  it("matches the shared layout version and stays under 6 MB", () => {
    expect(manifest.version).toBe(PORTUS_TOWN_VERSION);
    expect(manifest.items).toBe(TOWN_LAYOUT.length);
    const total = readdirSync(dir).reduce((s, f) => s + statSync(new URL(f, dir)).size, 0);
    expect(total).toBeLessThanOrEqual(6_000_000);
    for (const f of Object.values(manifest.files)) {
      const b = bytes(f.name);
      expect(b.length, f.name).toBe(f.bytes);
      expect(createHash("sha256").update(b).digest("hex"), f.name).toBe(f.sha256);
    }
  });

  it("ships two WebP strips of square layers, one per slot layer", () => {
    const layers = manifest.layers.length;
    for (const f of [manifest.files.color, manifest.files.normal]) expect(webpSize(bytes(f.name)), f.name).toEqual([manifest.layerSize, manifest.layerSize * layers]);
    for (const s of manifest.slots) expect(s.layer).toBeLessThan(layers);
  });

  it("is a meshopt GLB with the two town materials and one node per prefab and LOD", () => {
    const b = bytes(manifest.files.glb.name);
    const doc = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
    expect(doc.extensionsRequired).toContain("EXT_meshopt_compression");
    expect(doc.materials.map((m: { name: string }) => m.name).sort()).toEqual(["town_cutout", "town_opaque"]);
    expect(doc.images ?? []).toEqual([]);
    const names = new Set(doc.nodes.map((n: { name: string }) => n.name));
    for (const p of TOWN_PREFABS) {
      expect(names.has(p.name), p.name).toBe(true);
      expect(names.has(`${p.name}__L1`), `${p.name}__L1`).toBe(p.tris[1] > 0);
    }
  });

  it("decodes to the layout's prefabs with the expected triangle counts and sane data", async () => {
    const { meshes } = await testTownAssets();
    expect(() => validateTown(meshes, manifest)).not.toThrow();
    const lod0 = TOWN_LAYOUT.reduce((s, it) => s + TOWN_PREFABS[it[0]]!.tris[0], 0);
    expect(lod0).toBe(manifest.trianglesLod0);
    // Prefabs stand on their pivot: bases near y = 0 (plinths go a little below), fronts toward +z.
    const house = meshes.get("house_a")!.opaque!;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < house.position.length; i += 3) {
      minY = Math.min(minY, house.position[i]!);
      maxY = Math.max(maxY, house.position[i]!);
    }
    expect(minY).toBeGreaterThan(-1.6);
    expect(maxY).toBeCloseTo(TOWN_PREFABS.find((p) => p.name === "house_a")!.height, 0);
    // Trees have alpha-tested leaves; their LOD1 is two crossed cards.
    expect(meshes.get("tree_oak")!.cutout).not.toBeNull();
    expect(meshes.get("tree_oak__L1")!.cutout!.index.length / 3).toBe(4);
  });
});

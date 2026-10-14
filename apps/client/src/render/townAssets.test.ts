// The shipped Portus town (D38): manifest, sizes, hashes and a full decode of the meshopt GLB in Node
// (no DOM image decoder needed: the GLB has no textures; the WebP strips are checked by header).
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PORTUS_TOWN_VERSION, TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { loadTown, validateTown } from "./townAssets.ts";
import { testTownAssets, townBytes as bytes, townDir as dir, townManifest as manifest } from "./townAssets.testutil.ts";

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

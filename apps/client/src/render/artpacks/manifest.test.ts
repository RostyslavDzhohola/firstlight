// The shipped HD pack (public/assets-dev/packs/hd, tools/blender/artpacks) against the shipped base art:
// every file is there with its size and hash, and was built for the shipped file it replaces. A rebuild of
// the base art (a town layout, a character) without rebuilding its pack fails here, before the client
// would skip the pack at run time (town strips) or paint it onto the wrong UVs (characters, vegetation).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACK_IDS, PACK_TIERS, packGroups, textureGpuBytes, GPU_PACK_BUDGET_BYTES, type PackManifest } from "./catalog.ts";

const ASSETS = new URL("../../../public/assets-dev/", import.meta.url);
const PACK = new URL("packs/hd/", ASSETS);
const manifestUrl = new URL("manifest.json", PACK);
const sha = (u: URL) => createHash("sha256").update(readFileSync(u)).digest("hex");

/** A WebP's canvas size (VP8X, VP8 or VP8L header). */
function webpSize(b: Buffer): [number, number] {
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === "VP8L") {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}

describe.skipIf(!existsSync(manifestUrl))("the shipped HD art pack", () => {
  const m = JSON.parse(readFileSync(manifestUrl, "utf8")) as PackManifest;

  it("lists files that exist, with their sizes, hashes and dimensions", () => {
    expect(m.version).toBe(1);
    for (const [base, f] of Object.entries(m.files)) {
      expect(PACK_IDS, base).toContain(f.pack);
      const u = new URL(f.file, PACK);
      const bytes = readFileSync(u);
      expect(bytes.length, f.file).toBe(f.bytes);
      expect(sha(u), f.file).toBe(f.sha256);
      expect(webpSize(bytes), f.file).toEqual([f.width, f.height]);
      if (f.layers) expect(f.width * f.height, `${f.file}: a grid of ${f.layers} layers`).toBe(f.layerSize! * f.layerSize! * f.cols! * Math.ceil(f.layers / f.cols!));
      expect(Math.max(f.width, f.height), `${f.file}: WebP's limit`).toBeLessThanOrEqual(16383);
    }
  });

  it("was built for the shipped files it replaces", () => {
    for (const [base, f] of Object.entries(m.files)) {
      const file = base.split("#")[0]!;
      expect(sha(new URL(file, ASSETS)), `${base}: rebuild the pack after rebuilding the shipped art (tools/blender/artpacks/build.sh)`).toBe(f.baseSha256);
      if (f.pack === "town") {
        const site = file.startsWith("outposts/") ? file.split("/").slice(0, 3).join("/") : "portus";
        const shipped = JSON.parse(readFileSync(new URL(`${site}/manifest.json`, ASSETS), "utf8")) as { layers: string[]; layerSize: number };
        expect(f.layers, base).toBe(shipped.layers.length);
        expect(f.layerSize! % shipped.layerSize, base).toBe(0);
      }
    }
  });

  it("keeps every group's files in one pack, and every pack a tier takes within the GPU budget (nothing left out)", () => {
    for (const [g, files] of packGroups(m)) expect(new Set(files.map((f) => f.pack)).size, g).toBe(1);
    /** GPU bytes of the shipped texture a file replaces (RGBA8 with mips). */
    const shippedBytes = (base: string): number => {
      const [file, name] = base.split("#") as [string, string | undefined];
      if (name) {
        // an image embedded in a GLB: its PNG header
        const glb = readFileSync(new URL(file, ASSETS));
        const json = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12))) as {
          images: { name?: string; bufferView: number }[];
          bufferViews: { byteOffset?: number }[];
          textures: { source: number }[];
          materials: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
        };
        // by image name, else the base colour of the material of that name (as tools/blender/artpacks/glb_image.py)
        const tex = json.materials.find((m) => m.name === name)?.pbrMetallicRoughness?.baseColorTexture;
        const img = json.images.find((i) => i.name === name) ?? json.images[json.textures[tex!.index]!.source]!;
        const at = 28 + glb.readUInt32LE(12) + (json.bufferViews[img.bufferView]!.byteOffset ?? 0);
        return textureGpuBytes({ width: glb.readUInt32BE(at + 16), height: glb.readUInt32BE(at + 20) });
      }
      if (m.files[base]!.pack === "town") {
        const site = file.startsWith("outposts/") ? file.split("/").slice(0, 3).join("/") : "portus";
        const shipped = JSON.parse(readFileSync(new URL(`${site}/manifest.json`, ASSETS), "utf8")) as { layers: string[]; layerSize: number };
        return textureGpuBytes({ width: 0, height: 0, layerSize: shipped.layerSize, layers: shipped.layers.length });
      }
      const [width, height] = webpSize(readFileSync(new URL(file, ASSETS)));
      return textureGpuBytes({ width, height });
    };
    for (const tier of ["medium", "high", "ultra"] as const) {
      const more = Object.entries(m.files)
        .filter(([, f]) => PACK_TIERS[f.pack].includes(tier))
        .reduce((n, [base, f]) => n + textureGpuBytes(f) - shippedBytes(base), 0);
      expect(more, `${tier}: every pack it takes, every site visited`).toBeLessThanOrEqual(GPU_PACK_BUDGET_BYTES);
    }
  });
});

// The shipped Portus town decoded in Node (no fetch, no image decoder): the meshopt GLB through
// GLTFLoader, and 1-texel stand-ins for the two layer arrays.
import { readFileSync } from "node:fs";
import { stripTexture, parseTownGlb, type TownAssets, type TownManifest } from "./townAssets.ts";

export const townDir = new URL("../../public/assets-dev/portus/", import.meta.url);
export const townManifest = JSON.parse(readFileSync(new URL("manifest.json", townDir), "utf8")) as TownManifest;
export const townBytes = (name: string) => readFileSync(new URL(name, townDir));

let decoded: Promise<TownAssets> | null = null;
export function testTownAssets(): Promise<TownAssets> {
  return (decoded ??= (async () => {
    const b = townBytes(townManifest.files.glb.name);
    const meshes = await parseTownGlb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const layers = townManifest.layers.length;
    const px = (srgb: boolean) => stripTexture(new Uint8Array(4 * layers).fill(srgb ? 200 : 128), 1, layers, srgb);
    return { manifest: townManifest, meshes, color: px(true), normal: px(false) };
  })());
}

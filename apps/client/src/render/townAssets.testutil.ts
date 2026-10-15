// The shipped structure sites decoded in Node (no fetch, no image decoder): the meshopt GLB through
// GLTFLoader, and 1-texel stand-ins for the two layer arrays. Portus' town and each pad outpost.
import { readFileSync } from "node:fs";
import { siteFolder, stripTexture, parseTownGlb, type SiteId, type TownAssets, type TownManifest } from "./townAssets.ts";

const assetDir = new URL("../../public/assets-dev/", import.meta.url);
export const siteDir = (site: SiteId) => new URL(siteFolder(site), assetDir);
export const siteManifest = (site: SiteId) => JSON.parse(readFileSync(new URL("manifest.json", siteDir(site)), "utf8")) as TownManifest;
/** A shipped file of `site` by its manifest name (relative to the site's folder, "../../portus/…" included). */
export const siteBytes = (site: SiteId, name: string) => readFileSync(new URL(name, siteDir(site)));

export const townDir = siteDir("portus");
export const townManifest = siteManifest("portus");
export const townBytes = (name: string) => siteBytes("portus", name);

const decoded = new Map<SiteId, Promise<TownAssets>>();
/** The decoded site (cached): its meshes, and stand-in strips shared by sites with the same strip files. */
export function testSiteAssets(site: SiteId): Promise<TownAssets> {
  let p = decoded.get(site);
  if (!p) {
    p = (async () => {
      const manifest = siteManifest(site);
      const b = siteBytes(site, manifest.files.glb.name);
      const meshes = await parseTownGlb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      const layers = manifest.layers.length;
      const shared = manifest.files.color.name.includes("/portus/") ? await testTownAssets() : null;
      const px = (srgb: boolean) => stripTexture(new Uint8Array(4 * layers).fill(srgb ? 200 : 128), 1, layers, srgb);
      return { site, manifest, meshes, color: shared?.color ?? px(true), normal: shared?.normal ?? px(false) };
    })();
    decoded.set(site, p);
  }
  return p;
}

export function testTownAssets(): Promise<TownAssets> {
  return testSiteAssets("portus");
}

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODY_IDS, PROP_KINDS } from "@firstlight/shared";
import { PROP_PALETTES } from "./propGeometry.ts";
import { applyVegetationPalette, vegetationMaterial, vegetationPaletteBody, vegetationTints, vegetationTintUniforms } from "./vegetationAssets.ts";

// Vegetation materials are shared by every body (one shader per kind): the palette lives in uniforms,
// so a travel reuses the compiled programs instead of linking a new set per body.
describe("vegetation palette uniforms", () => {
  const atlas = new THREE.Texture();

  it("gives one material per kind and near/far, whatever the body", () => {
    applyVegetationPalette("arcadia");
    const oak = vegetationMaterial("oak", atlas);
    applyVegetationPalette("hollowmere");
    expect(vegetationMaterial("oak", atlas)).toBe(oak);
    expect(vegetationMaterial("oak", atlas, true)).not.toBe(oak);
    expect(oak.name).toBe("vegetation:oak:mesh");
  });

  it.each(BODY_IDS)("loads %s's tints (the colours the shader used to bake in)", (body) => {
    applyVegetationPalette(body);
    expect(vegetationPaletteBody()).toBe(body);
    const p = PROP_PALETTES[body];
    const ratio = (a: number, b: number) => {
      const x = new THREE.Color(a), y = new THREE.Color(b);
      return [x.r / y.r, x.g / y.g, x.b / y.b];
    };
    for (const kind of PROP_KINDS) {
      const u = vegetationTintUniforms(kind);
      const leafHex = kind === "blossom" ? p.blossom : kind === "pine" ? p.pine : kind === "scrub" ? p.scrub : p.leaf;
      const leaf = new THREE.Color(leafHex).multiplyScalar(3.6);
      expect(u.leaf.toArray()).toEqual(leaf.toArray());
      expect(u.bark.toArray().map((v) => +v.toFixed(6))).toEqual(ratio(p.bark, 0x6b4a2f).map((v) => +v.toFixed(6)));
      expect(u.stone.toArray().map((v) => +v.toFixed(6))).toEqual(ratio(kind === "boulder" ? p.rock2 : p.rock, 0xa3ada6).map((v) => +v.toFixed(6)));
      expect(vegetationTints(body, kind).leaf.toArray()).toEqual(u.leaf.toArray());
    }
  });
});

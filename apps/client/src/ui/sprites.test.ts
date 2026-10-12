import { describe, expect, it } from "vitest";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { ITEM_SPRITE, SPRITE_PALETTE, SPRITES, STARTER_PORTRAIT, itemSprite, spriteSvg } from "./sprites.ts";

describe("sprites", () => {
  it("every map is 16×16 and only uses palette colours", () => {
    for (const [name, rows] of Object.entries(SPRITES)) {
      expect(rows, name).toHaveLength(16);
      for (const row of rows) {
        expect(row, name).toHaveLength(16);
        for (const ch of row) if (ch !== ".") expect(SPRITE_PALETTE[ch], `${name} uses ${ch}`).toBeDefined();
      }
    }
  });

  it("has a sprite for every weapon and item and every starter portrait", () => {
    for (const w of WEAPONS) expect(SPRITES[ITEM_SPRITE[w.id] ?? ""], w.id).toBeDefined();
    for (const p of STARTER_PORTRAIT) expect(SPRITES[p], p).toBeDefined();
    expect(itemSprite("nope")).toBe("chest");
  });

  it("Brother Ash shows a face (skin pixels), not a dark hood with two glowing eyes", () => {
    const skin = SPRITES["head-ash"]!.join("").split("s").length - 1;
    expect(skin).toBeGreaterThan(20);
  });

  it("builds an SVG with one path per colour", () => {
    const svg = spriteSvg("coin");
    expect(svg).toContain("viewBox='0 0 16 16'");
    expect(svg.match(/<path /g)!.length).toBe(new Set(SPRITES.coin!.join("").replace(/\./g, "")).size);
  });
});

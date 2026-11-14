// @vitest-environment happy-dom
// Rendered weapon icons (weapons review 2): an item shows its rendered icon only once that image has
// loaded; until then, or when it fails, the pixel sprite, so an inventory or shop slot is never blank.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCULPTED_WEAPONS } from "../render/avatars/sculptedIds.ts";

type Mod = typeof import("./sprites.ts");

/** A stand-in for Image whose load or error the test fires. */
class FakeImage {
  static all: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  decode() {
    return Promise.resolve();
  }
  constructor() {
    FakeImage.all.push(this);
  }
}

describe("rendered weapon icons", () => {
  let s: Mod;
  beforeEach(async () => {
    FakeImage.all = [];
    vi.stubGlobal("Image", FakeImage);
    vi.resetModules();
    s = await import("./sprites.ts");
    s.installSprites(document);
  });

  it("before the image loads, and when it fails, the pixel sprite; after it loads, the icon", () => {
    const [a, b] = SCULPTED_WEAPONS;
    expect(s.itemSprite(a)).toBe(s.ITEM_SPRITE[a!]);
    const img = (id: string) => FakeImage.all.find((i) => i.src.endsWith(`icon_${id}.webp`))!;
    img(a!).onload!();
    img(b!).onerror!();
    expect(s.itemSprite(a)).toBe(`icon-${a}`);
    expect(s.itemSprite(b)).toBe(s.ITEM_SPRITE[b!]);
    expect(s.itemSprite(b)).not.toBe("chest");
  });

  it("asks for each rendered icon once", () => {
    expect(FakeImage.all.map((i) => i.src.split("/").pop()).sort()).toEqual(SCULPTED_WEAPONS.map((id) => `icon_${id}.webp`).sort());
  });
});

import { describe, expect, it } from "vitest";
import { placeCallout } from "./calloutPlace.ts";

const W = 1600, H = 900;
const BOX = { w: 150, h: 48 };
/** The open tutorial panel at 1600×900 in the live run. */
const PANEL = { left: 23, top: 107, right: 328, bottom: 717 };
const ndc = (sx: number, sy: number, z = 0.5) => ({ x: (sx / W) * 2 - 1, y: -((sy / H) * 2 - 1), z });

describe("world callout placement", () => {
  it("sits on its point when that's on screen and clear of the panel", () => {
    const p = placeCallout(ndc(900, 500), W, H, BOX, PANEL);
    expect(p).toMatchObject({ edge: false });
    expect(p.x).toBeCloseTo(900, 5);
    expect(p.y).toBeCloseTo(500, 5);
  });

  it("slides out from under the tutorial panel and points back at its target (live run: Arcadia over the checklist)", () => {
    const p = placeCallout(ndc(150, 377), W, H, BOX, PANEL);
    expect(p.edge).toBe(true);
    expect(p.x).toBeGreaterThan(PANEL.right);
    expect(Math.abs(p.angle)).toBeGreaterThan(Math.PI / 2); // pointing left, towards the portal
  });

  it("pins to the screen edge with an arrow when the target is off screen", () => {
    const p = placeCallout(ndc(2400, 450), W, H, BOX, null);
    expect(p.edge).toBe(true);
    expect(p.x).toBeLessThan(W);
    expect(p.x).toBeGreaterThan(W - 60);
    expect(Math.abs(p.angle)).toBeLessThan(0.2); // pointing right
    expect(p.flip).toBe(true); // its label sits on the inner side
  });

  it("points the other way for a target behind the camera", () => {
    // Behind the camera, three's projection mirrors x and y (z > 1): something behind and to the
    // left projects to the right of the screen.
    const p = placeCallout({ x: 0.4, y: 0, z: 1.2 }, W, H, BOX, null);
    expect(p.edge).toBe(true);
    expect(p.x).toBeLessThan(W / 2);
  });

  it("never pins under the panel, the compass or the hotbar", () => {
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      const p = placeCallout(ndc(800 + Math.cos(t) * 3000, 450 + Math.sin(t) * 3000), W, H, BOX, PANEL);
      expect(p.edge).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(80);
      expect(p.y).toBeLessThanOrEqual(H - 150);
      const underPanel = p.x >= PANEL.left && p.x <= PANEL.right && p.y >= PANEL.top && p.y <= PANEL.bottom;
      expect(underPanel).toBe(false);
    }
  });
});

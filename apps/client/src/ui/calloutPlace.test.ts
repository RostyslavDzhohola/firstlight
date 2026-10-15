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

  it("points outward for a target almost or exactly behind the camera (review: the arrow pointed back in)", () => {
    const near = placeCallout({ x: 0.01, y: 0, z: 1.2 }, W, H, BOX, null);
    expect(near.x).toBeLessThan(W / 2);
    expect(Math.abs(near.angle)).toBeGreaterThan(Math.PI * 0.9); // left, towards its edge
    const dead = placeCallout({ x: 0, y: 0, z: 1.2 }, W, H, BOX, null);
    expect(dead.y).toBeGreaterThan(H / 2);
    expect(dead.angle).toBeCloseTo(Math.PI / 2, 5); // down
    const beside = placeCallout({ x: 0.0228, y: -0.0167, z: 1.05 }, 1280, 720, BOX, { left: 18, top: 86, right: 262, bottom: 574 });
    expect(beside.x).toBeGreaterThan(262);
    expect(Math.cos(beside.angle)).toBeLessThan(0); // still towards the upper left, past the panel
    expect(Math.sin(beside.angle)).toBeLessThan(0);
  });

  it("stays finite for a point on the camera plane", () => {
    const p = placeCallout({ x: Infinity, y: NaN, z: NaN }, W, H, BOX, PANEL);
    for (const v of [p.x, p.y, p.angle]) expect(Number.isFinite(v)).toBe(true);
    expect(p.edge).toBe(true);
  });

  it("keeps the label off the panel on a narrow screen, and on screen near the right edge", () => {
    const panel = { left: 21, top: 80, right: 301, bottom: 600 };
    const box = { w: 270, h: 50 };
    const p = placeCallout({ x: -0.6, y: 0, z: 0.5 }, 600, 720, box, panel);
    expect(p.x).toBeGreaterThan(panel.right);
    expect(p.flip).toBe(false); // flipping would put the label back over the panel
    const right = placeCallout(ndc(1550, 450), W, H, BOX, PANEL);
    expect(right.edge).toBe(false);
    expect(right.flip).toBe(true);
    const left = placeCallout(ndc(900, 450), W, H, BOX, PANEL);
    expect(left.flip).toBe(false);
  });
});

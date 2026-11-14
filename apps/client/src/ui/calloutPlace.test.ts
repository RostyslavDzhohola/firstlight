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

  describe("keep-clear areas (D-polish-ux-6: the mission pointer off the crosshair and the top banners)", () => {
    const CROSS = { left: W / 2 - 40, top: H / 2 - 40, right: W / 2 + 40, bottom: H / 2 + 40 };
    const TOP = { left: W / 2 - 300, top: 0, right: W / 2 + 300, bottom: 190 };
    const label = (p: { x: number; y: number; flip: boolean; edge: boolean }) =>
      p.edge ? { left: p.flip ? p.x - 16 - BOX.w : p.x + 16, top: p.y - 24, right: p.flip ? p.x - 16 : p.x + 16 + BOX.w, bottom: p.y + 24 } : { left: p.flip ? p.x - 10 - BOX.w : p.x - 6, top: p.y - 78, right: p.flip ? p.x + 6 : p.x + 10 + BOX.w, bottom: p.y + 6 };
    const clear = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;

    it("takes the other side of its point when its label would cover the crosshair", () => {
      const p = placeCallout(ndc(W / 2 - 50, H / 2 + 40), W, H, BOX, null, [CROSS, TOP]);
      expect(p.edge).toBe(false);
      expect(p.flip).toBe(true);
      expect(clear(label(p), CROSS)).toBe(true);
    });

    it("stands beside the crosshair, pointing back, when neither side is clear", () => {
      const p = placeCallout(ndc(W / 2, H / 2 + 50), W, H, BOX, null, [CROSS, TOP]);
      expect(p.edge).toBe(true);
      expect(clear(label(p), CROSS)).toBe(true);
    });

    it("keeps off the zone banner and trial strip at the top centre", () => {
      const p = placeCallout(ndc(W / 2 + 10, 230), W, H, BOX, null, [CROSS, TOP]);
      expect(clear(label(p), TOP)).toBe(true);
    });

    it("changes nothing for a point well clear of them", () => {
      expect(placeCallout(ndc(1200, 600), W, H, BOX, null, [CROSS, TOP])).toEqual(placeCallout(ndc(1200, 600), W, H, BOX, null));
    });

    it("a label pinned at the top edge (target straight up the screen) drops below the top banners", () => {
      // Above the screen, dead ahead: pinned at the top margin, which is inside the top-centre column.
      const up = { x: 0, y: 3, z: 0.5 };
      const plain = placeCallout(up, W, H, BOX, null);
      expect(plain.edge).toBe(true);
      const kept = placeCallout(up, W, H, BOX, null, [CROSS, TOP]);
      expect(kept.edge).toBe(true);
      expect(kept.x).toBe(plain.x);
      expect(kept.y - BOX.h / 2).toBeGreaterThanOrEqual(TOP.bottom);
      // Pinned at a side edge it is untouched.
      const side = { x: 3, y: 0, z: 0.5 };
      expect(placeCallout(side, W, H, BOX, null, [CROSS, TOP])).toEqual(placeCallout(side, W, H, BOX, null));
    });
  });
});

// Play-through 2026-11-14: a target off to the right pinned the mission callout on the missions panel
// (top right). The panel is a kept-clear area: the pinned label drops below it.
describe("the missions panel is kept clear", () => {
  it("a pinned label at the right edge goes below the panel, not over it", () => {
    const w = 1280;
    const h = 720;
    const panel = { left: 986, top: 176, right: 1258, bottom: 426 };
    const box = { w: 120, h: 40 };
    // Off screen to the right and a little up: the ray meets the right margin at the panel's height.
    const c = placeCallout({ x: 3, y: 0.9, z: 0.5 }, w, h, box, null, [panel]);
    expect(c.edge).toBe(true);
    const left = c.flip ? c.x - 16 - box.w : c.x;
    const r = { left, top: c.y - box.h / 2, right: left + 16 + box.w, bottom: c.y + box.h / 2 };
    expect(r.top >= panel.bottom || r.bottom <= panel.top || r.right <= panel.left || r.left >= panel.right).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { bearingTo, headingOf, northAt, wrapDeg, type V3 } from "../social/compassMath.ts";
import { headingTo, mapView, metresPerPixel, offsetDir, panView, project, screenAngle, unproject, zoomView, type MapView } from "./mapView.ts";

const R = 500;
const at = (d: V3, r = R): V3 => [d[0] * r, d[1] * r, d[2] * r];
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Screen angle of b around a, clockwise from screen-up, in degrees. */
const screenBearing = (a: { x: number; y: number }, b: { x: number; y: number }) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;

// Where players really stand: the Portus spawn (the +Y pole), Arcadia's Dawnpad, a spot near the
// +Z pole, and a scatter.
const PLACES: V3[] = [
  [0, 1, 0],
  unit([1, (1 + Math.sqrt(5)) / 2, 0]),
  unit([0.05, 0.1, 1]),
  ...Array.from({ length: 12 }, (_, i) => {
    const z = -0.95 + (1.9 * i) / 11;
    const a = i * 2.399963;
    const r = Math.sqrt(1 - z * z);
    return [Math.cos(a) * r, Math.sin(a) * r, z] as V3;
  }),
];

function view(c: V3, rot = 0, ppr = 4000): MapView {
  return mapView(c, rot, ppr, 600, 600);
}

describe("map projection agrees with the compass (owner: \"the map is inverted\")", () => {
  it("draws a point due east of the player to the right of the player when north is up", () => {
    for (const d of PLACES) {
      const v = view(d);
      const me = project(v, d);
      const east = project(v, offsetDir(d, 20, 0, R));
      const north = project(v, offsetDir(d, 0, 20, R));
      expect(east.x - me.x).toBeGreaterThan(15);
      expect(Math.abs(east.y - me.y)).toBeLessThan(0.5);
      expect(me.y - north.y).toBeGreaterThan(15);
      expect(Math.abs(north.x - me.x)).toBeLessThan(0.5);
      // ...and the compass calls it east: heading 90.
      expect(headingOf(at(d), [at(offsetDir(d, 20, 0, R))[0] - at(d)[0], at(offsetDir(d, 20, 0, R))[1] - at(d)[1], at(offsetDir(d, 20, 0, R))[2] - at(d)[2]])).toBeCloseTo(90, 0);
    }
  });

  it("puts every target at its compass bearing, north-up", () => {
    for (const d of PLACES) {
      const v = view(d);
      const me = project(v, d);
      for (let k = 0; k < 16; k++) {
        const target = offsetDir(d, Math.cos(k) * 60, Math.sin(k * 1.7) * 60, R);
        const compass = bearingTo(at(d), northAt(at(d)), at(target));
        expect(Math.abs(wrapDeg(screenBearing(me, project(v, target)) - compass))).toBeLessThan(1.5);
        expect(Math.abs(wrapDeg(headingTo(d, target) - compass))).toBeLessThan(0.01);
      }
    }
  });

  it("player-up: what the compass says is ahead is up, and its right is right", () => {
    for (const d of PLACES) {
      for (const heading of [0, 37, 90, 200, 300]) {
        const v = view(d, heading);
        const me = project(v, d);
        for (let k = 0; k < 8; k++) {
          const target = offsetDir(d, Math.sin(k * 2.1) * 50, Math.cos(k * 1.3) * 50, R);
          // The compass strip: bearing relative to where you look (heading).
          const rel = wrapDeg(headingTo(d, target) - heading);
          expect(Math.abs(wrapDeg(screenBearing(me, project(v, target)) - rel))).toBeLessThan(1.5);
        }
      }
    }
  });

  it("hides the far side of the globe", () => {
    const v = view([0, 1, 0], 0, 300);
    expect(project(v, [0, -1, 0]).z).toBeLessThan(0);
    expect(project(v, [0, 1, 0]).z).toBeCloseTo(1, 9);
  });
});

describe("map navigation", () => {
  it("unprojects what it projects", () => {
    for (const d of PLACES) {
      const v = view(d, 33);
      const t = offsetDir(d, 40, -25, R);
      const s = project(v, t);
      const back = unproject(v, s.x, s.y)!;
      expect(Math.hypot(back[0] - t[0], back[1] - t[1], back[2] - t[2]) * R).toBeLessThan(0.01);
    }
    expect(unproject(view([0, 1, 0], 0, 100), 0, 0)).toBeNull(); // off the globe
  });

  it("zooms about the cursor: the point under it stays put", () => {
    // Within a few degrees of the +Z pole a north-up map can't hold every point under the cursor
    // (the circle of possible centres goes round the pole); everywhere players live it's exact.
    for (const d of PLACES.filter((p) => Math.abs(p[2]) < 0.9)) {
      const v = view(d, 0, 2000);
      const under = unproject(v, 420, 210)!;
      for (const k of [1.5, 3, 0.4]) {
        const z = zoomView(v, k, 420, 210);
        const s = project(z, under);
        expect(Math.hypot(s.x - 420, s.y - 210)).toBeLessThan(0.75);
        expect(z.ppr).toBeCloseTo(v.ppr * k, 6);
      }
    }
  });

  it("drags the ground with the pointer and keeps north up", () => {
    for (const d of PLACES.filter((p) => Math.abs(p[2]) < 0.9)) {
      const v = view(d, 0, 3000);
      const grabbed = unproject(v, 300, 300)!;
      const p = panView(v, 45, -30);
      const s = project(p, grabbed);
      expect(s.x).toBeCloseTo(345, 0);
      expect(s.y).toBeCloseTo(270, 0);
      // North-up after panning: the new centre's north still points straight up.
      const c = p.c;
      const up = project(p, offsetDir(c, 0, 10, R));
      const mid = project(p, c);
      expect(Math.abs(up.x - mid.x)).toBeLessThan(0.5);
    }
  });

  it("stays finite next to the pole", () => {
    const v = view(unit([0.05, 0.1, 1]), 0, 2000);
    const z = zoomView(v, 0.4, 420, 210);
    const p = panView(z, 300, -200);
    for (const n of [...z.c, ...p.c, ...p.e, ...p.n]) expect(Number.isFinite(n)).toBe(true);
  });

  it("points your arrow along your facing wherever the map is panned (review: ~90° off near the pole)", () => {
    const deg = (r: number) => (r * 180) / Math.PI;
    // You stand near the +Z pole, facing north; the map is panned 60 m away, north-up.
    const me = unit([0.03, 0.04, 1]);
    const north = northAt(at(me));
    const v = mapView(offsetDir(me, 60, -10, R), 0, 4000, 600, 600);
    const s = project(v, me);
    const ahead = project(v, offsetDir(me, 0, 5, R));
    const drawn = Math.atan2(ahead.x - s.x, -(ahead.y - s.y));
    expect(Math.abs(wrapDeg(deg(screenAngle(v, north)) - deg(drawn)))).toBeLessThan(1);
    // Centring the map on yourself would give heading - turn = 0 (straight up); panned, it isn't.
    expect(Math.abs(wrapDeg(deg(drawn)))).toBeGreaterThan(20);
    // Everywhere else it still agrees with the projected direction, in either turn.
    for (const d of PLACES) {
      for (const rot of [0, 130]) {
        const pv = mapView(offsetDir(d, -40, 25, R), rot, 3000, 600, 600);
        const f = northAt(at(offsetDir(d, 0, 0, R)));
        const p0 = project(pv, d), p1 = project(pv, offsetDir(d, 0, 3, R));
        expect(Math.abs(wrapDeg(deg(screenAngle(pv, f)) - deg(Math.atan2(p1.x - p0.x, -(p1.y - p0.y)))))).toBeLessThan(1);
      }
    }
  });

  it("reports the ground scale at the centre", () => {
    expect(metresPerPixel(view([0, 1, 0], 0, 1000), 500)).toBeCloseTo(0.5, 9);
  });
});

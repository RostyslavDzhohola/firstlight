import { describe, expect, it } from "vitest";
import { BODY_IDS } from "./planet/bodies.ts";
import { HANGS, ORBIT_IDS, orbitPos, skyBodyPlace, SKY_SIZE_MAX, SKY_SIZE_MIN, type OrbitId } from "./orbits.ts";
import { DAY_MS, dayT, sunAngles } from "./sky.ts";

const T0 = 1_763_000_000_000;
const vec = (elev: number, az: number) => [Math.cos(elev) * Math.cos(az), Math.cos(elev) * Math.sin(az), Math.sin(elev)];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Where `body` is in `viewer`'s sky at server time `ms` with both clocks running. */
function at(viewer: OrbitId, body: OrbitId, ms: number) {
  const sun = sunAngles(viewer, dayT(viewer, ms));
  return { sun, place: skyBodyPlace(viewer, body, sun.elev, sun.az, ms) };
}

describe("orbits (#5)", () => {
  it("is a pure function of the server clock: the same answer everywhere", () => {
    for (const id of ORBIT_IDS) expect(orbitPos(id, T0)).toEqual(orbitPos(id, T0));
    const a = at("arcadia", "meridian", T0).place;
    expect({ ...a }).toEqual({ ...at("arcadia", "meridian", T0).place });
  });

  it("keeps each body on its ring and Lumen round Arcadia", () => {
    const p = orbitPos("arcadia", T0), m = orbitPos("lumen", T0);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(5.6, 9);
    expect(Math.hypot(m[0] - p[0], m[1] - p[1])).toBeCloseTo(0.55, 9);
  });

  it("places a body on the ecliptic: its angle from the sun is its elongation", () => {
    for (let i = 0; i < 40; i++) {
      const ms = T0 + i * 0.137 * DAY_MS;
      const { sun, place } = at("arcadia", "lumen", ms);
      const sep = Math.acos(dot(vec(sun.elev, sun.az), vec(place.elev, place.az)));
      expect(Math.abs(sep - Math.abs(place.elong))).toBeLessThan(0.04); // Lumen's 0.03 rad off the ecliptic
    }
  });

  it("a body east of the sun trails it across the sky (rises and sets after it)", () => {
    for (let i = 0; i < 60; i++) {
      const ms = T0 + i * 0.29 * DAY_MS;
      const { place } = at("arcadia", "hollowmere", ms);
      if (Math.abs(place.elong) < 0.2 || Math.abs(place.elong) > 2.9) continue;
      const t = dayT("arcadia", ms), d = 0.02;
      const before = sunAngles("arcadia", t - d), after = sunAngles("arcadia", t + d);
      const b = vec(place.elev, place.az);
      const closerToEarlierSun = dot(b, vec(before.elev, before.az)) > dot(b, vec(after.elev, after.az));
      expect(closerToEarlierSun, `elong ${place.elong}`).toBe(place.elong > 0);
    }
  });

  it("every body rises and sets every game day on the planets (Portus's sun never sets: its sky circles)", () => {
    for (const viewer of ["arcadia", "hollowmere", "meridian"] as const) {
      for (const body of ORBIT_IDS) {
        if (body === viewer) continue;
        let prev = at(viewer, body, T0).place.elev, rises = 0, sets = 0, low = Infinity;
        for (let ms = T0; ms <= T0 + 4 * DAY_MS; ms += 10_000) {
          const e = at(viewer, body, ms).place.elev;
          low = Math.min(low, e);
          if (prev <= 0 && e > 0) rises++;
          if (prev > 0 && e <= 0) sets++;
          prev = e;
        }
        // Lumen loses a day on the sun every ~2.5 days (like any moon): it rises a little later each day.
        const want = body === "lumen" ? 2 : 3;
        // Hollowmere's sky is a high-latitude one: an inner world near its sun circles the pole instead.
        if (low > 0) continue;
        expect(rises, `${body} from ${viewer}`).toBeGreaterThanOrEqual(want);
        expect(sets, `${body} from ${viewer}`).toBeGreaterThanOrEqual(want);
      }
    }
  });

  it("drifts against the sun over the days: the elongation changes, Lumen's in a few days round", () => {
    const e0 = at("arcadia", "meridian", T0).place.elong;
    expect(Math.abs(at("arcadia", "meridian", T0 + 2 * DAY_MS).place.elong - e0)).toBeGreaterThan(0.2);
    // Lumen goes all the way round the sun (new to full to new) within three game days.
    const seen = new Set<number>();
    for (let ms = T0; ms <= T0 + 3 * DAY_MS; ms += DAY_MS / 20) seen.add(Math.floor(((at("arcadia", "lumen", ms).place.elong + Math.PI) / (2 * Math.PI)) * 8));
    expect(seen.size).toBe(8);
  });

  it("moves smoothly (no jump between nearby times) and sizes stay readable", () => {
    for (const viewer of BODY_IDS) {
      let prev = vec(at(viewer, "lumen", T0).place.elev, at(viewer, "lumen", T0).place.az);
      for (let ms = T0; ms <= T0 + DAY_MS; ms += 2_000) {
        const { place } = at(viewer, viewer === "arcadia" ? "lumen" : "arcadia", ms);
        const v = vec(place.elev, place.az);
        if (ms > T0) expect(Math.acos(Math.min(1, dot(v, prev)))).toBeLessThan(0.02);
        prev = v;
        expect(place.size).toBeGreaterThanOrEqual(SKY_SIZE_MIN);
        expect(place.size).toBeLessThanOrEqual(SKY_SIZE_MAX);
      }
    }
  });

  it("Arcadia hangs still in Lumen's sky (Lumen keeps one face to it)", () => {
    const a = skyBodyPlace("lumen", "arcadia", 0.5, 1, T0), b = skyBodyPlace("lumen", "arcadia", -0.2, 3, T0 + 1.7 * DAY_MS);
    expect([a.elev, a.az]).toEqual([HANGS.lumen!.elev, HANGS.lumen!.az]);
    expect([b.elev, b.az]).toEqual([a.elev, a.az]);
  });
});

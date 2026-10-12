import { describe, expect, it } from "vitest";
import { BODY_IDS } from "./planet/bodies.ts";
import {
  DAY_MS, dayT, NIGHT_FRACTION, nextStrike, SKY_PROFILES, skyState, slotIndex, slotStartMs, slotWeather, sunAngles,
  WEATHER_RAMP_MS, weatherAmount, WEATHERS,
} from "./sky.ts";

const T0 = Date.UTC(2026, 9, 12, 3, 0, 0);

describe("day/night clock", () => {
  it("is a pure function of server time and body", () => {
    for (const b of BODY_IDS) {
      expect(dayT(b, T0)).toBe(dayT(b, T0));
      expect(dayT(b, T0 + DAY_MS)).toBeCloseTo(dayT(b, T0), 9);
      expect(dayT(b, T0)).toBeGreaterThanOrEqual(0);
      expect(dayT(b, T0)).toBeLessThan(1);
    }
    // Bodies sit at different times of day.
    const ts = BODY_IDS.map((b) => dayT(b, T0));
    expect(new Set(ts.map((t) => t.toFixed(3))).size).toBe(BODY_IDS.length);
  });

  it("gives planets a 25% night and keeps Portus in daylight", () => {
    for (const b of ["arcadia", "hollowmere", "meridian"] as const) {
      let night = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) if (sunAngles(b, i / n).elev < 0) night++;
      expect(night / n).toBeCloseTo(NIGHT_FRACTION, 2);
      expect(sunAngles(b, 0.5).elev).toBeCloseTo(SKY_PROFILES[b].maxElev, 6);
      expect(sunAngles(b, 0).elev).toBeCloseTo(SKY_PROFILES[b].minElev, 6);
    }
    for (let i = 0; i < 200; i++) expect(sunAngles("portus", i / 200).elev).toBeGreaterThan(0.05);
  });
});

describe("weather schedule", () => {
  it("is deterministic per body copy and changes per slot", () => {
    for (const b of BODY_IDS) {
      const a = skyState(b, 1, T0);
      const c = skyState(b, 1, T0);
      expect(c).toEqual(a);
      // Same slot, later time: same weather, same boundaries.
      const later = skyState(b, 1, T0 + 1000);
      expect(later.weather).toBe(a.weather);
      expect(later.nextChangeAt).toBe(a.nextChangeAt);
      expect(a.nextChangeAt - a.slotStart).toBe(SKY_PROFILES[b].slotMs);
      expect(a.slotStart).toBeLessThanOrEqual(T0);
      expect(a.nextChangeAt).toBeGreaterThan(T0);
      // The next slot's weather is what the state announced.
      expect(skyState(b, 1, a.nextChangeAt).weather).toBe(a.nextWeather);
    }
  });

  it("follows each body's weather table", () => {
    for (const b of BODY_IDS) {
      const allowed = new Set(SKY_PROFILES[b].weather.map(([w]) => w));
      const seen = new Map<string, number>();
      for (let k = 0; k < 3000; k++) {
        const w = slotWeather(b, 0, k);
        expect(allowed.has(w.weather)).toBe(true);
        expect(WEATHERS).toContain(w.weather);
        if (w.weather === "clear") expect(w.intensity).toBe(0);
        else expect(w.intensity).toBeGreaterThanOrEqual(0.45);
        seen.set(w.weather, (seen.get(w.weather) ?? 0) + 1);
      }
      const total = SKY_PROFILES[b].weather.reduce((s, [, w]) => s + w, 0);
      for (const [kind, weight] of SKY_PROFILES[b].weather) expect((seen.get(kind) ?? 0) / 3000).toBeCloseTo(weight / total, 1);
    }
    expect(SKY_PROFILES.meridian.weather.some(([w]) => w === "rain" || w === "storm")).toBe(false);
  });

  it("copies of a body can differ, slot boundaries are aligned", () => {
    let differ = 0;
    for (let k = 0; k < 200; k++) if (slotWeather("arcadia", 0, k).weather !== slotWeather("arcadia", 1, k).weather) differ++;
    expect(differ).toBeGreaterThan(20);
    const k = slotIndex("arcadia", T0);
    expect(slotIndex("arcadia", slotStartMs("arcadia", k))).toBe(k);
    expect(slotIndex("arcadia", slotStartMs("arcadia", k) - 1)).toBe(k - 1);
  });

  it("fades weather in and out at slot boundaries", () => {
    // Find a slot whose neighbours differ.
    let s = skyState("arcadia", 0, T0);
    for (let i = 0; i < 400 && (s.weather === "clear" || s.prevWeather === s.weather || s.nextWeather === s.weather); i++) {
      s = skyState("arcadia", 0, s.nextChangeAt + 1);
    }
    expect(s.weather).not.toBe("clear");
    expect(weatherAmount(s, s.slotStart)).toBe(0);
    expect(weatherAmount(s, s.slotStart + WEATHER_RAMP_MS)).toBeCloseTo(s.intensity, 6);
    expect(weatherAmount(s, s.nextChangeAt)).toBe(0);
    expect(weatherAmount(s, s.slotStart + WEATHER_RAMP_MS / 2)).toBeCloseTo(s.intensity / 2, 6);
  });

  it("applies and expires admin overrides", () => {
    const o = skyState("meridian", 0, T0, 0, { weather: "dust", intensity: 0.9, until: T0 + 60_000 });
    expect(o.override).toBe(true);
    expect(o.weather).toBe("dust");
    expect(weatherAmount(o, T0)).toBeCloseTo(0.9, 6);
    expect(skyState("meridian", 0, T0 + 61_000, 0, { weather: "dust", intensity: 0.9, until: T0 + 60_000 }).override).toBe(false);
  });

  it("schedules lightning only in storms, identically for every client", () => {
    let s = skyState("arcadia", 0, T0);
    for (let i = 0; i < 2000 && s.weather !== "storm"; i++) s = skyState("arcadia", 0, s.nextChangeAt + 1);
    expect(s.weather).toBe("storm");
    const a = nextStrike(s, s.slotStart);
    expect(a).not.toBeNull();
    expect(nextStrike({ ...s }, s.slotStart)).toEqual(a);
    expect(a!.at).toBeGreaterThanOrEqual(s.slotStart + 6000);
    expect(a!.distance).toBeGreaterThanOrEqual(250);
    const b = nextStrike(s, a!.at + 1);
    if (b) expect(b.at - a!.at).toBeGreaterThanOrEqual(6000);
    expect(nextStrike(skyState("meridian", 0, T0, 0, { weather: "dust", intensity: 1, until: T0 + 1e6 }), T0)).toBeNull();
  });
});

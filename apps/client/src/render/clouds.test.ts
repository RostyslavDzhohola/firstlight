// The cloud layer's cover (D-gfx-worlds-1): each planet's clear-weather sky, closed by the weather.
import { describe, expect, it } from "vitest";
import { applyCloudLook, cloudCover, cloudUniforms, setCloudWeather } from "./clouds.ts";
import { WORLD_LOOKS } from "./worldLooks.ts";

describe("cloud cover", () => {
  it("clear weather shows the planet's own sky; rain closes it", () => {
    for (const body of ["arcadia", "hollowmere", "meridian", "portus"] as const) {
      const look = WORLD_LOOKS[body].clouds;
      applyCloudLook(look);
      expect(cloudCover(0), body).toBeCloseTo(look.cover, 6);
      expect(cloudCover(1), body).toBeLessThan(look.cover); // a lower threshold = more cloud
      expect(cloudCover(0.5), body).toBeLessThan(cloudCover(0));
      expect(cloudCover(0.5), body).toBeGreaterThan(cloudCover(1));
      setCloudWeather(0.65);
      expect(cloudUniforms.cover.value).toBeCloseTo(cloudCover(0.65), 6);
    }
  });

  it("the planets' skies differ: Hollowmere's low overcast, Meridian's thin high streaks", () => {
    const { arcadia, hollowmere, meridian } = WORLD_LOOKS;
    expect(hollowmere.clouds.cover).toBeLessThan(arcadia.clouds.cover);
    expect(meridian.clouds.cover).toBeGreaterThan(arcadia.clouds.cover);
    expect(meridian.clouds.height).toBeGreaterThan(arcadia.clouds.height);
    expect(Math.min(...meridian.clouds.stretch)).toBeLessThan(0.5);
  });
});

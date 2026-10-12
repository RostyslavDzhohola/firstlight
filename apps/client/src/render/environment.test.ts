import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { SKY_PROFILES, sunAngles } from "@firstlight/shared";
import { atmo, SunRig } from "./atmosphere.ts";
import { Environment, lightFactors, referenceDayT } from "./environment.ts";
import { LOOKS } from "./looks.ts";
import { emptyStored, resolveSettings, type Feature } from "./quality.ts";
import type { RenderCtx } from "./renderer.ts";

function fakeCtx(kill: Feature[] = []) {
  const scene = new THREE.Scene();
  const settings = resolveSettings("medium", false, true, emptyStored(), new Set(kill));
  const renderer = { toneMappingExposure: 1 };
  return { scene, settings, renderer, onChange: () => () => {} } as unknown as RenderCtx;
}

function setup(body: "arcadia" | "portus" | "meridian" | "hollowmere" = "arcadia", kill: Feature[] = []) {
  const ctx = fakeCtx(kill);
  const thunder: number[] = [];
  const audio = { setWeather: () => {}, thunder: (d: number) => thunder.push(d) };
  const particles = { moteBoost: 1 };
  const env = new Environment(ctx, audio, particles);
  const look = LOOKS[body];
  const rig = new SunRig(ctx.scene, look);
  env.setBody(body, 0, look, rig);
  return { ctx, env, rig, look, particles, thunder };
}

/** Run `seconds` of frames at 60 fps. */
function run(env: Environment, seconds: number, camera = new THREE.PerspectiveCamera()) {
  camera.position.set(0, 502, 0);
  for (let i = 0; i < seconds * 60; i++) {
    env.update(1 / 60);
    env.afterCamera(camera, 1 / 60);
  }
}

afterEach(() => vi.useRealTimers());

describe("day/night", () => {
  it("reference time reproduces each body's reference sun", () => {
    for (const b of ["arcadia", "hollowmere", "meridian", "portus"] as const) {
      const t = referenceDayT(b, LOOKS[b].sunElev);
      expect(sunAngles(b, t).elev).toBeCloseTo(Math.min(LOOKS[b].sunElev, SKY_PROFILES[b].maxElev), 5);
    }
  });

  it("night is readable: moon key, bright fill, raised exposure, stars, glowing pads", () => {
    const { env, rig, look, particles, ctx } = setup("arcadia");
    env.timeOverride = 0; // midnight
    env.weatherOverride = { weather: "clear", intensity: 0 };
    run(env, 2);
    expect(env.night).toBeGreaterThan(0.9);
    expect(rig.sky.keyIsMoon).toBe(true);
    expect(rig.sun.intensity).toBeGreaterThan(0.5);
    expect(rig.hemi.intensity).toBeGreaterThan(0.8);
    expect(ctx.renderer.toneMappingExposure).toBeGreaterThan(look.exposure * 1.3);
    expect(atmo.stars.value).toBeGreaterThan(0.8);
    expect(atmo.glowBoost.value).toBeGreaterThan(1.5);
    expect(particles.moteBoost).toBeGreaterThan(2);
    // Sky never goes black.
    const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    expect(lum(atmo.horizon.value)).toBeGreaterThan(0.005);
  });

  it("noon is daylight: sun key, no stars", () => {
    const { env, rig, look } = setup("arcadia");
    env.timeOverride = 0.5;
    env.weatherOverride = { weather: "clear", intensity: 0 };
    run(env, 1);
    expect(env.night).toBe(0);
    expect(rig.sky.keyIsMoon).toBe(false);
    expect(rig.sun.intensity).toBeGreaterThan(look.sunIntensity * 0.8);
    expect(atmo.stars.value).toBe(0);
  });

  it("Portus never gets a night", () => {
    for (let i = 0; i < 48; i++) expect(lightFactors(sunAngles("portus", i / 48).elev).night).toBe(0);
  });

  it("?nodaynight keeps the body's reference sun", () => {
    const { env, rig, look } = setup("hollowmere", ["daynight"]);
    run(env, 0.2);
    expect(rig.sky.sunElev).toBe(look.sunElev);
    expect(env.night).toBe(0);
  });
});

describe("weather", () => {
  it("rain fills the box, wets surfaces over time and ripples water", () => {
    const { env } = setup("arcadia");
    env.timeOverride = 0.5;
    env.weatherOverride = { weather: "rain", intensity: 1 };
    run(env, 8); // weather eases in with a 2.5 s time constant
    const n = (env.fx.drops.geometry as THREE.InstancedBufferGeometry).instanceCount;
    expect(n).toBeGreaterThan(3000); // Medium budget 4000 × amount
    expect(n).toBeLessThanOrEqual(4000);
    expect(env.fx.drops.visible).toBe(true);
    expect(atmo.rain.value).toBeGreaterThan(0.5);
    const early = atmo.wet.value;
    run(env, 20);
    expect(atmo.wet.value).toBeGreaterThan(early);
    expect(atmo.wet.value).toBeGreaterThan(0.6);
    // Clearing up: drops fade, surfaces dry slowly.
    env.weatherOverride = { weather: "clear", intensity: 0 };
    run(env, 10);
    expect((env.fx.drops.geometry as THREE.InstancedBufferGeometry).instanceCount).toBeLessThan(200);
    expect(atmo.wet.value).toBeGreaterThan(0.3);
  });

  it("Meridian dust: motes, dust-tinted haze, more fog, no wetness", () => {
    const { env, look } = setup("meridian");
    env.timeOverride = 0.5;
    env.weatherOverride = { weather: "dust", intensity: 1 };
    run(env, 4);
    expect(atmo.fogTintAmt.value).toBeGreaterThan(0.6);
    expect(atmo.fogDensity.value).toBeGreaterThan(look.fogDensity * 3);
    expect(atmo.wet.value).toBe(0);
    expect((env.fx.drops.geometry as THREE.InstancedBufferGeometry).instanceCount).toBeGreaterThan(2000);
  });

  it("?noweather keeps the live sky clear", () => {
    const { env } = setup("hollowmere", ["weather"]);
    run(env, 2);
    expect(env.weather === "clear" || env.weatherIntensity < 0.01).toBe(true);
    expect((env.fx.drops.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
  });

  it("storms flash and thunder", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 12, 12), toFake: ["Date"] });
    const { env, thunder } = setup("arcadia");
    env.timeOverride = 0.5;
    env.setOverrides(null, { weather: "storm", intensity: 1 });
    let flashes = 0;
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 502, 0);
    for (let s = 0; s < 60 * 60; s++) {
      vi.setSystemTime(Date.now() + 1000 / 60);
      env.update(1 / 60);
      env.afterCamera(cam, 1 / 60);
      if (atmo.flash.value > 0.5) flashes++;
    }
    expect(thunder.length).toBeGreaterThan(1);
    expect(flashes).toBeGreaterThan(0);
    // Thunder delay = distance / 343 m/s.
    for (const d of thunder) expect(d).toBeGreaterThanOrEqual(250 / 343 - 1e-9);
  });
});

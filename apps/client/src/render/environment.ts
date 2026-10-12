// Day/night cycle and weather on the client (SPEC §6.14 #3/#4). Turns the sky state (the server's
// "sky" messages, or the same deterministic schedule computed locally when offline) into uniform
// values every frame: sky palette and scattering LUT slice, sun/moon key light, fill light, fog,
// exposure, bloom and grade, glow boost for emissive props, wetness, the camera-local rain/dust box,
// lightning and the weather sound bed. Uniforms only: the time of day and the weather never
// recompile a shader, and nothing here allocates per frame.

import * as THREE from "three/webgpu";
import {
  dayT as dayAt, DAY_MS, isWeather, nextStrike, skyState, SKY_PROFILES, sunAngles, weatherAmount,
  type BodyId, type SkyState, type Strike, type Weather,
} from "@firstlight/shared";
import { flags } from "../config.ts";
import { atmo, type SunRig } from "./atmosphere.ts";
import type { BodyLook } from "./looks.ts";
import { MENU_GRADE, postUniforms, setGrade, type GradeParams } from "./post.ts";
import type { ResolvedSettings } from "./quality.ts";
import type { RenderCtx } from "./renderer.ts";
import { sliceFor } from "./skyLut.ts";
import { WeatherFx } from "./weather.ts";

export interface WeatherLook {
  /** Cloud cover 0..1: dims the sun, greys the sky, hides stars. */
  cloud: number;
  fogMul: number;
  hazeMul: number;
  fogStartMul: number;
  /** Fraction of the tier's drop budget at full intensity (0 = no particles). */
  drops: number;
  /** Fall speed (m/s), streak length and width (m), opacity. */
  fall: number;
  len: number;
  width: number;
  alpha: number;
  /** Wind (m/s) across the box. */
  wind: number;
  /** How wet surfaces get at full intensity. */
  wet: number;
  /** 1 = dust motes and dust-tinted haze. */
  dust: number;
  /** Rain sound and wind sound at full intensity. */
  rainSound: number;
  windSound: number;
}

export const WEATHER_LOOKS: Record<Weather, WeatherLook> = {
  clear: { cloud: 0, fogMul: 1, hazeMul: 1, fogStartMul: 1, drops: 0, fall: 9, len: 0.5, width: 0.012, alpha: 0, wind: 0, wet: 0, dust: 0, rainSound: 0, windSound: 0 },
  rain: { cloud: 0.65, fogMul: 1.8, hazeMul: 1.6, fogStartMul: 0.7, drops: 1, fall: 9, len: 0.55, width: 0.012, alpha: 0.32, wind: 2, wet: 1, dust: 0, rainSound: 0.8, windSound: 0.2 },
  storm: { cloud: 0.9, fogMul: 2.3, hazeMul: 2, fogStartMul: 0.6, drops: 1, fall: 11, len: 0.7, width: 0.014, alpha: 0.38, wind: 5, wet: 1, dust: 0, rainSound: 1, windSound: 0.6 },
  drizzle: { cloud: 0.45, fogMul: 2.6, hazeMul: 2.2, fogStartMul: 0.5, drops: 0.45, fall: 4.5, len: 0.22, width: 0.008, alpha: 0.24, wind: 1, wet: 0.6, dust: 0, rainSound: 0.35, windSound: 0.1 },
  fog: { cloud: 0.4, fogMul: 4.5, hazeMul: 3, fogStartMul: 0.25, drops: 0, fall: 1, len: 0.1, width: 0.01, alpha: 0, wind: 0.5, wet: 0.2, dust: 0, rainSound: 0, windSound: 0.1 },
  dust: { cloud: 0.3, fogMul: 5, hazeMul: 4, fogStartMul: 0.3, drops: 0.8, fall: 0.6, len: 0.09, width: 0.09, alpha: 0.2, wind: 7, wet: 0, dust: 1, rainSound: 0, windSound: 1 },
};

/** Night grade: cooler, slightly desaturated, lifted shadows (blended in by the night factor). */
const NIGHT_GRADE: GradeParams = { slope: [0.92, 0.98, 1.12], offset: [0.0, 0.006, 0.02], power: [1.04, 1.02, 0.98], saturation: 0.85, hue: 0 };
const DUSK_SUN = new THREE.Color(0xff9a5a);
const OVERCAST = new THREE.Color(0x8a94a4);
const RAIN_DAY = new THREE.Color(0.62, 0.66, 0.74);
const RAIN_NIGHT = new THREE.Color(0.1, 0.12, 0.18);

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Exponential approach factor for a time constant (s). */
const approach = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-3, tau));

/** Time of day where the sun first reaches `elev` in the morning (the body's reference look). */
export function referenceDayT(body: BodyId, elev: number): number {
  const p = SKY_PROFILES[body];
  const s = Math.min(1, Math.max(0, (elev - p.minElev) / (p.maxElev - p.minElev)));
  return 0.25 + Math.asin(2 * s - 1) / (2 * Math.PI);
}

/** Derived per-frame factors from a sun elevation (exported for tests). */
export function lightFactors(elev: number): { night: number; dusk: number; sunUp: number } {
  const night = smooth(0.06, -0.1, elev);
  const dusk = smooth(0.45, 0.02, elev) * (1 - night);
  const sunUp = smooth(-0.02, 0.22, elev);
  return { night, dusk, sunUp };
}

export interface EnvAudio {
  setWeather(rain: number, wind: number): void;
  thunder(delaySec: number, distance: number): void;
}

export interface EnvParticles {
  moteBoost: number;
}

export class Environment {
  readonly fx: WeatherFx;
  private body: BodyId = "portus";
  private copy = 0;
  private look: BodyLook | null = null;
  private rig: SunRig | null = null;
  private settings: ResolvedSettings;
  // Clock.
  private server: SkyState | null = null;
  private serverDelta = 0;
  private haveDelta = false;
  private local: SkyState | null = null;
  private readonly t0 = performance.now();
  private readonly speed = Math.max(0, Number(flags.get("dayspeed")) || 1);
  // Overrides (URL dev flags, photo mode, bench).
  timeOverride: number | null = null;
  weatherOverride: { weather: Weather; intensity: number } | null = null;
  private overrideSince = 0;
  /** Menu grade (look rule 1) while a menu is open. */
  menu = false;
  /** Photo mode look: a fixed grade (null = the living sky grade) and an exposure multiplier. */
  photoGrade: GradeParams | null = null;
  photoExposure = 1;
  // Smoothed state.
  private kind: Weather = "clear";
  private amount = 0;
  private wetness = 0;
  private strike: Strike | null = null;
  private fired = -1;
  private flashAt = -1e9;
  private flashDist = 400;
  private pendingStrike: Strike | null = null;
  // Outputs (read by HUD/photo/bench).
  dayT = 0.3;
  sunElev = 0.5;
  night = 0;
  // Scratch (no per-frame allocation).
  private readonly grade: GradeParams = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1, hue: 0 };
  private readonly c1 = new THREE.Color();
  private readonly c2 = new THREE.Color();
  private readonly rainColor = new THREE.Color();
  private readonly cols = {
    dayZenith: new THREE.Color(), dayMid: new THREE.Color(), dayHorizon: new THREE.Color(), dayGround: new THREE.Color(),
    nightZenith: new THREE.Color(), nightMid: new THREE.Color(), nightHorizon: new THREE.Color(), nightGround: new THREE.Color(),
    glow: new THREE.Color(), sun: new THREE.Color(), moon: new THREE.Color(),
    hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), nightHemiSky: new THREE.Color(), nightHemiGround: new THREE.Color(),
  };
  private drops = { amount: 0, kind: 0, fall: 9, wind: 0, len: 0.5, width: 0.012, alpha: 0 };

  constructor(private readonly ctx: RenderCtx, private readonly audio: EnvAudio | null = null, private readonly particles: EnvParticles | null = null) {
    this.fx = new WeatherFx(ctx.scene);
    this.settings = ctx.settings;
    this.applySettings(ctx.settings);
    ctx.onChange((s) => this.applySettings(s));
    // Dev/check flags: ?time=0..1, ?weather=rain|storm|drizzle|fog|dust|clear (&weatherint=0..1), ?dayspeed=N.
    const t = Number(flags.get("time"));
    if (flags.get("time") !== null && Number.isFinite(t)) this.timeOverride = ((t % 1) + 1) % 1;
    const w = flags.get("weather");
    if (isWeather(w)) {
      this.weatherOverride = { weather: w, intensity: Math.max(0, Math.min(1, Number(flags.get("weatherint")) || 0.9)) };
      this.overrideSince = Date.now();
    }
  }

  applySettings(s: ResolvedSettings) {
    this.settings = s;
    this.fx.setCapacity(s.weatherDrops);
  }

  /** A new body (or copy): the look and lights to drive. */
  setBody(body: BodyId, copy: number, look: BodyLook, rig: SunRig) {
    this.body = body;
    this.copy = copy;
    this.look = look;
    this.rig = rig;
    this.server = null;
    this.local = null;
    this.strike = null;
    this.pendingStrike = null;
    this.kind = "clear";
    this.amount = 0;
    this.loadPalette();
    // Moonlight comes from the highest sky planet, so the light matches what you see.
    let best = look.skyPlanets[0];
    for (const p of look.skyPlanets) if (best && p.elevDeg > best.elevDeg) best = p;
    if (best) {
      rig.sky.moonElev = THREE.MathUtils.degToRad(Math.max(18, best.elevDeg));
      rig.sky.moonAz = THREE.MathUtils.degToRad(best.azDeg);
    }
  }

  /** Bench: a fixed, repeatable sky (the body's reference time, clear unless the URL says otherwise). */
  setBenchMode(body: BodyId, look: BodyLook) {
    if (this.timeOverride === null) this.timeOverride = referenceDayT(body, look.sunElev);
    if (!this.weatherOverride) this.weatherOverride = { weather: "clear", intensity: 0 };
  }

  /** Authoritative sky from the server ("sky" message). */
  setServerSky(s: SkyState) {
    if (s.body !== this.body) return;
    const delta = s.serverTime - Date.now();
    this.serverDelta = this.haveDelta ? this.serverDelta + (delta - this.serverDelta) * 0.3 : delta;
    this.haveDelta = true;
    this.copy = s.copy;
    this.server = s;
  }

  /** Photo mode overrides (local only; null = back to the URL/bench/live sky). */
  photoTime: number | null = null;
  photoWeather: { weather: Weather; intensity: number } | null = null;

  setOverrides(time: number | null, weather: { weather: Weather; intensity: number } | null) {
    this.photoTime = time;
    if (weather?.weather !== this.photoWeather?.weather) this.overrideSince = this.serverNow();
    this.photoWeather = weather;
  }

  private get timeOv(): number | null {
    return this.photoTime ?? this.timeOverride;
  }

  private get weatherOv(): { weather: Weather; intensity: number } | null {
    return this.photoWeather ?? this.weatherOverride;
  }

  private serverNow(): number {
    const live = Date.now() + (this.haveDelta ? this.serverDelta : 0);
    return this.speed !== 1 ? live + (this.speed - 1) * (performance.now() - this.t0) : live;
  }

  /** The sky state to show now (server's, else the local deterministic schedule). */
  private state(now: number): SkyState {
    const s = this.server;
    if (s && now < s.nextChangeAt + 2000) return s;
    if (!this.local || now >= this.local.nextChangeAt || this.local.copy !== this.copy) {
      this.local = skyState(this.body, this.copy, now, s?.dayOffset ?? 0);
    }
    return this.local;
  }

  /** Per frame, before the planet updates (sets the sun angles the rig uses). */
  update(dt: number) {
    const look = this.look;
    const rig = this.rig;
    if (!look || !rig) return;
    const on = this.settings.on;
    const now = this.serverNow();
    const st = this.state(now);

    // ---- time of day
    let elev: number, az: number;
    if (!on.daynight && this.timeOv === null) {
      elev = look.sunElev;
      az = look.sunAz;
      this.dayT = referenceDayT(this.body, elev);
    } else {
      this.dayT = this.timeOv ?? dayAt(this.body, now, st.dayOffset);
      const a = sunAngles(this.body, this.dayT);
      elev = a.elev;
      az = a.az;
    }
    this.sunElev = elev;
    const { night, dusk, sunUp } = lightFactors(elev);
    this.night = night;

    // ---- weather (target → smoothed kind/amount)
    let wKind: Weather = "clear";
    let wAmt = 0;
    if (this.weatherOv) {
      wKind = this.weatherOv.weather;
      wAmt = wKind === "clear" ? 0 : this.weatherOv.intensity;
    } else if (on.weather) {
      wKind = st.weather;
      wAmt = weatherAmount(st, now);
    }
    if (wKind === this.kind || this.amount < 0.01) {
      if (wKind !== this.kind) this.kind = wKind;
      this.amount += (wAmt - this.amount) * approach(dt, 2.5);
    } else {
      this.amount += (0 - this.amount) * approach(dt, 1.5); // fade the old weather out first
    }
    const wl = WEATHER_LOOKS[this.kind];
    const a = this.amount;
    const cloud = wl.cloud * a;
    const wetTarget = wl.wet * a;
    this.wetness += (wetTarget - this.wetness) * approach(dt, wetTarget > this.wetness ? 15 : 90);

    // ---- lightning (deterministic per copy; local overrides use their own clock)
    let flash = 0;
    if (this.kind === "storm" && a > 0.2) {
      const src = this.weatherOv ? this.overrideStorm(st) : st;
      if (!this.strike || this.strike.at < now - 2000) this.strike = nextStrike(src, now);
      const s = this.strike;
      if (s && now >= s.at && this.fired !== s.at) {
        this.fired = s.at;
        this.flashAt = s.at;
        this.flashDist = s.distance;
        this.pendingStrike = s;
        this.audio?.thunder(s.distance / 343, s.distance);
      }
      const t = (now - this.flashAt) / 1000;
      if (t >= 0 && t < 1.2) flash = (Math.exp(-t * 9) + (t > 0.13 ? 0.65 * Math.exp(-(t - 0.13) * 11) : 0)) * Math.min(1, 500 / this.flashDist);
    }

    // ---- sky palette (day ↔ night, dusk warmth, overcast)
    const C = this.cols;
    this.sky(C.dayZenith, C.nightZenith, night, cloud, atmo.zenith.value);
    this.sky(C.dayMid, C.nightMid, night, cloud, atmo.mid.value);
    this.sky(C.dayHorizon, C.nightHorizon, night, cloud, this.c1);
    atmo.horizon.value.copy(this.c1).lerp(C.glow, dusk * 0.35);
    this.sky(C.dayGround, C.nightGround, night, cloud, atmo.ground.value);
    atmo.glow.value.copy(C.glow);
    atmo.glowStrength.value = look.glowStrength * (1 + dusk * 0.8) * (1 - cloud) * (1 - night * 0.6);
    atmo.mie.value = look.mie * (1 - cloud * 0.8) * (1 - night);
    atmo.sunColor.value.copy(C.sun).lerp(DUSK_SUN, dusk * 0.7);
    atmo.sunDisc.value = look.sunDisc * sunUp * (1 - cloud) * (1 - cloud);
    atmo.lutSlice.value = sliceFor(elev, [SKY_PROFILES[this.body].minElev, SKY_PROFILES[this.body].maxElev]);
    const baseMix = this.settings.sky.scatterSteps[0] > 0 ? look.scatter.mix : 0;
    atmo.scatterMix.value = baseMix * (1 - night * 0.85) * (1 - cloud * 0.6);
    atmo.stars.value = on.sky ? night * (1 - Math.min(1, cloud * 1.4)) : 0;
    atmo.flash.value = flash;
    atmo.wet.value = this.wetness;
    atmo.rain.value = wl.dust ? 0 : Math.min(1, a * wl.drops * 1.2);
    atmo.glowBoost.value = 1 + 0.75 * night + 0.25 * cloud;

    // ---- fog / haze
    atmo.fogDensity.value = look.fogDensity * lerp(1, wl.fogMul, a) * (1 + night * 0.25);
    atmo.haze.value = look.haze * lerp(1, wl.hazeMul, a);
    atmo.fogStart.value = look.fogStart * lerp(1, wl.fogStartMul, a);
    atmo.fogTintAmt.value = wl.dust * a * 0.8;

    // ---- lights: sun by day, moon at night, fill from the sky
    const sk = rig.sky;
    sk.sunElev = elev;
    sk.sunAz = az;
    sk.keyIsMoon = night > 0.4;
    this.c1.copy(C.sun).lerp(DUSK_SUN, dusk * 0.8);
    const sunI = look.sunIntensity * sunUp * (1 - cloud * 0.75);
    const moonI = look.night.moonIntensity * night * (1 - cloud * 0.5);
    if (sk.keyIsMoon) rig.setKey(C.moon, moonI);
    else rig.setKey(this.c1, sunI);
    this.c1.copy(C.hemiSky).lerp(C.nightHemiSky, night);
    if (cloud > 0) this.c1.lerp(OVERCAST, cloud * 0.4);
    this.c2.copy(C.hemiGround).lerp(C.nightHemiGround, night);
    rig.setFill(this.c1, this.c2, lerp(look.hemiIntensity, look.night.hemiIntensity, night) * (1 + cloud * 0.15) + flash * 2.2);

    // ---- post: exposure, bloom, grade
    this.ctx.renderer.toneMappingExposure = look.exposure * lerp(1, look.night.exposure, night) * (1 + flash * 0.45) * this.photoExposure;
    postUniforms.bloomThreshold.value = lerp(look.bloomThreshold, 0.85, night);
    postUniforms.bloomStrength.value = look.bloomStrength * (1 + 0.6 * night);
    if (this.menu) setGrade(MENU_GRADE);
    else if (this.photoGrade) setGrade(this.photoGrade);
    else setGrade(this.currentGrade());

    // ---- particles: motes brighter at night
    if (this.particles) this.particles.moteBoost = 1 + 1.4 * night;

    // ---- weather box parameters (applied after the camera moves)
    const d = this.drops;
    d.amount = on.weather || this.weatherOv ? wl.drops * a : 0;
    d.kind = wl.dust;
    d.fall = wl.fall;
    d.wind = wl.wind;
    d.len = wl.len;
    d.width = wl.width;
    d.alpha = wl.alpha;
    if (wl.dust) this.rainColor.copy(atmo.fogTint.value).multiplyScalar(lerp(1.1, 0.18, night));
    else this.rainColor.copy(RAIN_DAY).lerp(RAIN_NIGHT, night).multiplyScalar(1 + flash * 3);
    this.audio?.setWeather(wl.rainSound * a, wl.windSound * a);
  }

  /** Day ↔ night colour, greyed and dimmed under cloud cover. */
  private sky(day: THREE.Color, nightC: THREE.Color, night: number, cloud: number, out: THREE.Color) {
    out.copy(day).lerp(nightC, night);
    if (cloud > 0) {
      const lum = out.r * 0.2126 + out.g * 0.7152 + out.b * 0.0722;
      this.c2.copy(OVERCAST).multiplyScalar(lum * 1.4 + 0.02);
      out.lerp(this.c2, cloud * 0.75).multiplyScalar(1 - 0.3 * cloud);
    }
  }

  private stormState: SkyState | null = null;

  /** A storm on the override's own clock (photo/URL storms get lightning too). */
  private overrideStorm(st: SkyState): SkyState {
    const s = this.stormState;
    if (s && s.slotStart === this.overrideSince && s.body === st.body && s.copy === st.copy) return s;
    this.stormState = { ...st, weather: "storm", slotStart: this.overrideSince, nextChangeAt: this.overrideSince + 3_600_000, override: true };
    return this.stormState;
  }

  /** The planet's grade at this time of day and weather (photo mode's "Planet" filter). */
  currentGrade(): GradeParams {
    const look = this.look;
    const g = this.grade;
    if (!look) return MENU_GRADE;
    const n = this.night * 0.8;
    for (let i = 0; i < 3; i++) {
      g.slope[i] = lerp(look.grade.slope[i]!, NIGHT_GRADE.slope[i]!, n);
      g.offset[i] = lerp(look.grade.offset[i]!, NIGHT_GRADE.offset[i]!, n);
      g.power[i] = lerp(look.grade.power[i]!, NIGHT_GRADE.power[i]!, n);
    }
    const cloud = WEATHER_LOOKS[this.kind].cloud * this.amount;
    g.saturation = lerp(look.grade.saturation, NIGHT_GRADE.saturation, n) * (1 - 0.25 * cloud);
    g.hue = look.grade.hue;
    if (this.kind === "dust") {
      g.slope[0] *= 1 + 0.06 * this.amount;
      g.slope[2] *= 1 - 0.08 * this.amount;
    }
    return g;
  }

  /** Per frame, after the camera is placed: the rain box and lightning bolt follow it. */
  afterCamera(camera: THREE.Camera, dt: number) {
    const d = this.drops;
    // Wind across the box: mostly along local east, a little north.
    this.fx.update(dt, camera, d.amount, d.kind, d.fall, d.wind * 0.85, d.wind * 0.5, d.len, d.width, d.alpha, this.rainColor);
    if (this.pendingStrike) {
      const s = this.pendingStrike;
      this.pendingStrike = null;
      if (this.settings.on.weather || this.weatherOv) this.fx.strike(camera, s.az, s.distance, s.seed);
    }
    this.fx.updateBolt(camera, atmo.flash.value * 1.6);
  }

  private describeKey = "";
  private described = "";

  /** "arcadia · 14:05 rain 70%" for the F3 overlay / photo panel (cached: no per-frame string). */
  describe(): string {
    const mins = Math.floor(this.dayT * 24 * 60);
    const pct = this.amount > 0.01 ? Math.round(this.amount * 20) * 5 : 0;
    const key = `${this.body}${mins}${this.kind}${pct}`;
    if (key !== this.describeKey) {
      this.describeKey = key;
      const h = Math.floor(mins / 60), m = mins % 60;
      this.described = `${this.body} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${this.kind}${pct ? ` ${pct}%` : ""}`;
    }
    return this.described;
  }

  get weather(): Weather {
    return this.kind;
  }

  get weatherIntensity(): number {
    return this.amount;
  }

  /** Load the body's palette into the scratch colours (call after setBody). */
  loadPalette() {
    const look = this.look;
    if (!look) return;
    const C = this.cols;
    C.dayZenith.setHex(look.zenith);
    C.dayMid.setHex(look.mid);
    C.dayHorizon.setHex(look.horizon);
    C.dayGround.setHex(look.ground);
    C.nightZenith.setHex(look.night.zenith);
    C.nightMid.setHex(look.night.mid);
    C.nightHorizon.setHex(look.night.horizon);
    C.nightGround.setHex(look.night.ground);
    C.glow.setHex(look.glow);
    C.sun.setHex(look.sun);
    C.moon.setHex(look.night.moon);
    C.hemiSky.setHex(look.hemiSky);
    C.hemiGround.setHex(look.hemiGround);
    C.nightHemiSky.setHex(look.night.hemiSky);
    C.nightHemiGround.setHex(look.night.hemiGround);
  }

  dispose() {
    this.fx.dispose();
  }
}

/** A full day takes this long (re-exported for UI text). */
export const DAY_LENGTH_MS = DAY_MS;

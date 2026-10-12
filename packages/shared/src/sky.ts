// Time of day and weather per body copy (SPEC §6.14 #3/#4). Pure and deterministic: a function of
// the server clock, the body and the copy number, so the server, every client and the offline bench
// agree without streaming state. The server stays authoritative (it sends the state on sync and on
// change, plus admin overrides); clients extrapolate between messages.

import type { BodyId } from "./planet/bodies.ts";
import { hash01, hash4 } from "./rng.ts";

/** One full day/night cycle. */
export const DAY_MS = 40 * 60_000;
/** Fraction of the cycle with the sun below the horizon on planets (Portus never gets night). */
export const NIGHT_FRACTION = 0.25;
/** Clients re-sync this often (slow drift correction). */
export const SKY_SYNC_MS = 120_000;
/** Weather fades in/out over this long at slot boundaries. */
export const WEATHER_RAMP_MS = 45_000;

export type Weather = "clear" | "rain" | "storm" | "drizzle" | "fog" | "dust";
export const WEATHERS: readonly Weather[] = ["clear", "rain", "storm", "drizzle", "fog", "dust"];

export function isWeather(v: unknown): v is Weather {
  return typeof v === "string" && (WEATHERS as readonly string[]).includes(v);
}

export interface SkyProfile {
  /** Phase offset of the body's day (0..1), so bodies sit at different times. */
  phase: number;
  /** Sun elevation range over the day (radians). Planets: min chosen for a 25% night. */
  minElev: number;
  maxElev: number;
  /** Sun azimuth at noon in the local sky frame (radians). */
  noonAz: number;
  /** Weather slot length. */
  slotMs: number;
  /** Weather table: kind → weight. */
  weather: readonly (readonly [Weather, number])[];
}

/** Sun elevation minimum that gives NIGHT_FRACTION of night for a sinusoidal day. */
export function nightMinElev(maxElev: number): number {
  // e(t) = min + (max − min)(sin u + 1)/2 is below 0 for a fraction f when
  // −min / (max − min) = (1 − cos(π f)) / 2, i.e. 0.1464 for f = 0.25.
  const k = (1 - Math.cos(Math.PI * NIGHT_FRACTION)) / 2;
  return (-maxElev * k) / (1 - k);
}

export const SKY_PROFILES: Record<BodyId, SkyProfile> = {
  // The hub keeps a gentle dusk-to-dawn range: the sun never sets.
  portus: { phase: 0.0, minElev: 0.06, maxElev: 0.95, noonAz: 0.6, slotMs: 9 * 60_000, weather: [["clear", 0.85], ["drizzle", 0.15]] },
  // Occasional summer storms.
  arcadia: { phase: 0.31, minElev: nightMinElev(1.1), maxElev: 1.1, noonAz: 0.9, slotMs: 7 * 60_000, weather: [["clear", 0.6], ["rain", 0.18], ["storm", 0.12], ["fog", 0.1]] },
  // Low violet sun; frequent drizzle and fog.
  hollowmere: { phase: 0.62, minElev: nightMinElev(0.45), maxElev: 0.45, noonAz: 2.2, slotMs: 6 * 60_000, weather: [["drizzle", 0.4], ["fog", 0.3], ["clear", 0.2], ["storm", 0.1]] },
  // Hard white sun; dust storms instead of rain.
  meridian: { phase: 0.83, minElev: nightMinElev(1.35), maxElev: 1.35, noonAz: 1.4, slotMs: 8 * 60_000, weather: [["clear", 0.62], ["dust", 0.38]] },
};

const BODY_SEED: Record<BodyId, number> = { portus: 0x51a7, arcadia: 0xa2c4, hollowmere: 0x40e3, meridian: 0x3e21 };

const frac = (x: number) => x - Math.floor(x);

/** Time of day 0..1 (0 = midnight, 0.25 ≈ sunrise side, 0.5 = noon) for a server time. */
export function dayT(body: BodyId, serverMs: number, dayOffset = 0): number {
  return frac(serverMs / DAY_MS + SKY_PROFILES[body].phase + dayOffset);
}

/** Sun elevation and azimuth (radians, local sky frame) at time of day t. */
export function sunAngles(body: BodyId, t: number, out: { elev: number; az: number } = { elev: 0, az: 0 }): { elev: number; az: number } {
  const p = SKY_PROFILES[body];
  const s = (Math.sin(2 * Math.PI * (t - 0.25)) + 1) / 2;
  out.elev = p.minElev + (p.maxElev - p.minElev) * s;
  out.az = p.noonAz + 2 * Math.PI * (t - 0.5);
  return out;
}

export interface SlotWeather {
  weather: Weather;
  /** 0..1 (0 for clear). */
  intensity: number;
}

/** The weather of slot `k` on a body copy. */
export function slotWeather(body: BodyId, copy: number, k: number): SlotWeather {
  const p = SKY_PROFILES[body];
  const seed = hash4(BODY_SEED[body], copy, k, 0x5ca1);
  let total = 0;
  for (const [, w] of p.weather) total += w;
  let r = hash01(seed, 1) * total;
  let weather: Weather = p.weather[p.weather.length - 1]![0];
  for (const [kind, w] of p.weather) {
    if (r < w) {
      weather = kind;
      break;
    }
    r -= w;
  }
  const intensity = weather === "clear" ? 0 : 0.45 + 0.55 * hash01(seed, 2);
  return { weather, intensity };
}

export function slotIndex(body: BodyId, serverMs: number): number {
  const p = SKY_PROFILES[body];
  return Math.floor((serverMs + p.phase * p.slotMs) / p.slotMs);
}

export function slotStartMs(body: BodyId, k: number): number {
  const p = SKY_PROFILES[body];
  return k * p.slotMs - p.phase * p.slotMs;
}

/** What the server sends ("sky") and what clients extrapolate from. */
export interface SkyState {
  body: BodyId;
  copy: number;
  /** Server clock when the state was made (ms since epoch). */
  serverTime: number;
  /** Extra phase added to the day clock (admin staging); 0 normally. */
  dayOffset: number;
  dayT: number;
  weather: Weather;
  intensity: number;
  prevWeather: Weather;
  slotStart: number;
  nextChangeAt: number;
  nextWeather: Weather;
  nextIntensity: number;
  /** An admin override is active (weather fixed until nextChangeAt). */
  override: boolean;
  /** Admin staging: the time of day is held here (the clock is frozen); absent normally. */
  dayHold?: number;
}

export interface SkyOverride {
  weather: Weather;
  intensity: number;
  /** Server time the override was set: its fixed "slot start", so its state (and lightning) doesn't drift. */
  since: number;
  until: number;
}

/** The sky of a body copy at a server time (with an optional admin override and held time of day). */
export function skyState(
  body: BodyId, copy: number, serverMs: number, dayOffset = 0, override: SkyOverride | null = null, dayHold: number | null = null,
): SkyState {
  const k = slotIndex(body, serverMs);
  const cur = slotWeather(body, copy, k);
  const prev = slotWeather(body, copy, k - 1);
  const next = slotWeather(body, copy, k + 1);
  const start = slotStartMs(body, k);
  const base: SkyState = {
    body, copy, serverTime: serverMs, dayOffset, dayT: dayT(body, serverMs, dayOffset),
    weather: cur.weather, intensity: cur.intensity, prevWeather: prev.weather,
    slotStart: start, nextChangeAt: start + SKY_PROFILES[body].slotMs,
    nextWeather: next.weather, nextIntensity: next.intensity, override: false,
  };
  if (dayHold !== null) {
    base.dayT = dayHold;
    base.dayHold = dayHold;
  }
  if (override && override.until > serverMs) {
    return {
      ...base, weather: override.weather, intensity: override.weather === "clear" ? 0 : override.intensity,
      prevWeather: override.weather, slotStart: override.since, nextChangeAt: override.until,
      nextWeather: override.weather, override: true,
    };
  }
  return base;
}

/**
 * How strongly the state's weather shows at `ms` (0..1): fades in after the slot starts and out
 * before it ends, unless the neighbouring slot has the same kind of weather.
 */
export function weatherAmount(s: SkyState, ms: number): number {
  if (s.weather === "clear") return 0;
  const fadeIn = s.prevWeather === s.weather ? 1 : Math.min(1, Math.max(0, (ms - s.slotStart) / WEATHER_RAMP_MS));
  const fadeOut = s.nextWeather === s.weather || s.override ? 1 : Math.min(1, Math.max(0, (s.nextChangeAt - ms) / WEATHER_RAMP_MS));
  return s.intensity * Math.min(fadeIn, fadeOut);
}

export interface Strike {
  /** Server time of the flash. */
  at: number;
  /** Direction in the local sky frame (radians) and distance (m) of the bolt. */
  az: number;
  distance: number;
  seed: number;
}

// Any change to the lightning schedule (these constants, nextStrike) must bump the shared protocol version.
/** Lightning cadence: strike i of a storm sits at slotStart + (i + 1)·EVERY ± JITTER, so consecutive
 * strikes are 6–25 s apart (mean 15.5 s) for a storm of any length. */
const STRIKE_EVERY_MS = 15_500;
const STRIKE_JITTER_MS = 4_750;
const STRIKE_TIME_SALT = 0x1717;
const STRIKE_SEED_SALT = 0x5eed;

/**
 * The first lightning strike at or after `ms` in a storm slot (deterministic, so every client on
 * the copy flashes together), or null when the slot isn't a storm or no strike is left in it.
 * Found in O(1): only the strikes around `ms` are computed.
 */
export function nextStrike(s: SkyState, ms: number): Strike | null {
  if (s.weather !== "storm") return null;
  const k = Math.round(s.slotStart / 1000);
  // Strikes before index i are at least EVERY − JITTER before ms and strike i + 2 is after it.
  let i = Math.max(0, Math.floor((ms - s.slotStart) / STRIKE_EVERY_MS) - 1);
  for (let end = i + 2; i <= end; i++) {
    const jitter = (2 * hash01(BODY_SEED[s.body] ^ STRIKE_TIME_SALT, s.copy, k, i) - 1) * STRIKE_JITTER_MS;
    const at = s.slotStart + (i + 1) * STRIKE_EVERY_MS + jitter;
    if (at >= s.nextChangeAt) return null;
    if (at >= ms) {
      const seed = hash4(BODY_SEED[s.body] ^ STRIKE_SEED_SALT, s.copy, k, i);
      return { at, az: hash01(seed, 1) * Math.PI * 2, distance: 250 + 450 * hash01(seed, 2), seed };
    }
  }
  return null;
}

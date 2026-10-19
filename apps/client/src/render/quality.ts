// Quality tiers (SPEC §7.3), per-feature toggles, URL kill switches and persisted graphics settings.
// The tier table is the single source of truth: every render system reads the resolved settings
// from here and re-applies when they change (RenderCtx.onChange).

import { flags } from "../config.ts";

export type Tier = "low" | "medium" | "high" | "ultra";
export const TIERS: readonly Tier[] = ["low", "medium", "high", "ultra"];

export function tierIndex(t: Tier): number {
  return TIERS.indexOf(t);
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** Feature toggles. Each one has a `?no<name>` URL kill switch and a checkbox in the F3 panel. */
export const FEATURES = [
  "bloom",
  "fog",
  "sky",
  "skyplanets",
  "grass",
  "trees",
  "water",
  "shadows",
  "cascades",
  "ao",
  "traa",
  "fxaa",
  "grade",
  "grain",
  "vignette",
  "post",
  "particles",
  "motes",
  "detail",
  "chars",
  "destruct",
  "weather",
  "daynight",
] as const;
export type Feature = (typeof FEATURES)[number];

/** Features that are off unless the user opts in (not yet verified visually). */
const DEFAULT_OFF: ReadonlySet<Feature> = new Set<Feature>(["traa", "cascades"]);

export interface TierSpec {
  dprCap: number;
  renderScale: number;
  /** GPU frame budget (ms) used by the probe and the resolution ladder. */
  gpuTargetMs: number;
  drawBudget: number;
  sky: { scatterSteps: [number, number]; planetAtmospheres: boolean };
  fog: { height: boolean; aerial: boolean };
  terrain: { detailLayers: 0 | 2 | 4; normals: boolean; bakedSun: boolean };
  /** Single-map mode: `extent` = half-size of the box around the player. Cascades (High+,
   * opt-in): SunLight with 2 cascades of `mapSize`² out to `far` metres. */
  shadows: { mode: "blob" | "map"; mapSize: number; extent: number; far: number; cascadeSize: number };
  grass: { count: number; radius: number; segments: 1 | 2 | 3 };
  props: { fullTo: number; lodTo: number };
  /** 0 colour + fresnel, 1 + baked depth + foam, 2 + ripples, 3 + (reserved: SSR on the nearest lake). */
  water: 0 | 1 | 2 | 3;
  post: { bloomScale: number; fxaa: boolean; vignette: boolean; grain: boolean; ao: "off" | "half" | "full"; traa: boolean };
  particles: number;
  motes: number;
  fullAvatars: number;
  /** Rain streaks / dust motes in the camera-local weather box at full intensity (one draw). */
  weatherDrops: number;
}

export const TIER_TABLE: Record<Tier, TierSpec> = {
  low: {
    dprCap: 1.0, renderScale: 0.67, gpuTargetMs: 16, drawBudget: 150,
    sky: { scatterSteps: [0, 0], planetAtmospheres: false },
    fog: { height: false, aerial: true },
    terrain: { detailLayers: 0, normals: false, bakedSun: true },
    shadows: { mode: "blob", mapSize: 0, extent: 0, far: 0, cascadeSize: 0 },
    grass: { count: 25_000, radius: 25, segments: 1 },
    props: { fullTo: 0, lodTo: 110 },
    water: 0,
    post: { bloomScale: 0.33, fxaa: false, vignette: false, grain: false, ao: "off", traa: false },
    particles: 2_000, motes: 60, fullAvatars: 8, weatherDrops: 1_500,
  },
  medium: {
    dprCap: 1.25, renderScale: 0.85, gpuTargetMs: 12, drawBudget: 250,
    sky: { scatterSteps: [8, 4], planetAtmospheres: false },
    fog: { height: true, aerial: true },
    terrain: { detailLayers: 2, normals: false, bakedSun: false },
    shadows: { mode: "map", mapSize: 1024, extent: 20, far: 40, cascadeSize: 0 },
    grass: { count: 80_000, radius: 40, segments: 2 },
    props: { fullTo: 30, lodTo: 150 },
    water: 1,
    post: { bloomScale: 0.5, fxaa: true, vignette: true, grain: true, ao: "off", traa: false },
    particles: 5_000, motes: 160, fullAvatars: 16, weatherDrops: 4_000,
  },
  high: {
    dprCap: 1.5, renderScale: 1.0, gpuTargetMs: 10, drawBudget: 400,
    sky: { scatterSteps: [16, 8], planetAtmospheres: true },
    fog: { height: true, aerial: true },
    terrain: { detailLayers: 4, normals: true, bakedSun: false },
    shadows: { mode: "map", mapSize: 2048, extent: 40, far: 80, cascadeSize: 1024 },
    grass: { count: 200_000, radius: 60, segments: 2 },
    props: { fullTo: 40, lodTo: 220 },
    water: 2,
    post: { bloomScale: 0.5, fxaa: true, vignette: true, grain: true, ao: "half", traa: true },
    particles: 15_000, motes: 300, fullAvatars: 24, weatherDrops: 8_000,
  },
  ultra: {
    dprCap: 2.0, renderScale: 1.0, gpuTargetMs: 7, drawBudget: 600,
    sky: { scatterSteps: [16, 8], planetAtmospheres: true },
    fog: { height: true, aerial: true },
    terrain: { detailLayers: 4, normals: true, bakedSun: false },
    shadows: { mode: "map", mapSize: 2048, extent: 60, far: 150, cascadeSize: 2048 },
    grass: { count: 500_000, radius: 85, segments: 3 },
    props: { fullTo: 60, lodTo: 260 },
    water: 3,
    post: { bloomScale: 0.5, fxaa: true, vignette: true, grain: true, ao: "full", traa: true },
    particles: 30_000, motes: 500, fullAvatars: 40, weatherDrops: 14_000,
  },
};

/**
 * High features that the automatic tier can take on top of its own (D-framerate-3): the probe adds the
 * ones this device's measured GPU headroom pays for (probe.ts). Each takes High's value for its
 * settings and never lowers a tier that has more. The tier's resolution and GPU budget stay its own.
 */
export const EXTRAS = ["detail4", "normals", "atmospheres", "water2", "shadows", "grass", "props", "ao"] as const;
export type Extra = (typeof EXTRAS)[number];

export function isExtra(v: unknown): v is Extra {
  return typeof v === "string" && (EXTRAS as readonly string[]).includes(v);
}

/** `spec` with `extras` applied (a new object; the tier table is never touched). */
export function withExtras(spec: TierSpec, extras: Iterable<Extra>): TierSpec {
  const hi = TIER_TABLE.high;
  const s: TierSpec = { ...spec, sky: { ...spec.sky }, terrain: { ...spec.terrain }, shadows: { ...spec.shadows }, grass: { ...spec.grass }, props: { ...spec.props }, post: { ...spec.post } };
  for (const e of extras) {
    switch (e) {
      case "detail4":
        s.terrain.detailLayers = 4;
        break;
      case "normals": // terrain normals need the 4 detail layers (terrainMaterial.ts)
        s.terrain.detailLayers = 4;
        s.terrain.normals = true;
        break;
      case "atmospheres":
        s.sky.planetAtmospheres = true;
        break;
      case "water2":
        s.water = Math.max(s.water, hi.water) as TierSpec["water"];
        break;
      case "shadows": // High's 2048² map over 40 m: Medium's sharpness twice as far; Low's blob shadows have none
        if (s.shadows.mode !== "map") break;
        s.shadows.mapSize = Math.max(s.shadows.mapSize, hi.shadows.mapSize);
        s.shadows.extent = Math.max(s.shadows.extent, hi.shadows.extent);
        s.shadows.far = Math.max(s.shadows.far, hi.shadows.far);
        break;
      case "grass":
        s.grass.count = Math.max(s.grass.count, hi.grass.count);
        s.grass.radius = Math.max(s.grass.radius, hi.grass.radius);
        s.grass.segments = Math.max(s.grass.segments, hi.grass.segments) as TierSpec["grass"]["segments"];
        break;
      case "props":
        s.props.fullTo = Math.max(s.props.fullTo, hi.props.fullTo);
        s.props.lodTo = Math.max(s.props.lodTo, hi.props.lodTo);
        break;
      case "ao": // GTAO at half resolution (WebGPU only, resolveSettings)
        if (s.post.ao === "off") s.post.ao = hi.post.ao;
        break;
    }
  }
  return s;
}

/** What the user chose (persisted). `tier: null` means automatic (probe result). */
export interface StoredGfx {
  v: 1;
  tier: Tier | null;
  /** Last probe result (or a ladder floor drop), valid only for the same backend + GPU. */
  autoTier: Tier | null;
  autoBackend: string | null;
  autoGpu: string | null;
  /** Extras the probe measured headroom for (D-framerate-3), valid with autoTier. Null: none recorded. */
  autoExtras: Extra[] | null;
  renderScale: number | null;
  features: Partial<Record<Feature, boolean>>;
}

export const STORAGE_KEY = "fl.gfx.v1";

export function emptyStored(): StoredGfx {
  return { v: 1, tier: null, autoTier: null, autoBackend: null, autoGpu: null, autoExtras: null, renderScale: null, features: {} };
}

/** Parse stored settings (tolerates junk, older shapes and missing fields). */
export function parseStored(raw: string | null): StoredGfx {
  const empty = emptyStored();
  if (!raw) return empty;
  try {
    const s = JSON.parse(raw) as Partial<StoredGfx>;
    if (!s || s.v !== 1) return empty;
    const features: Partial<Record<Feature, boolean>> = {};
    for (const f of FEATURES) if (typeof s.features?.[f] === "boolean") features[f] = s.features[f];
    return {
      v: 1,
      tier: isTier(s.tier) ? s.tier : null,
      autoTier: isTier(s.autoTier) ? s.autoTier : null,
      autoBackend: typeof s.autoBackend === "string" ? s.autoBackend : null,
      autoGpu: typeof s.autoGpu === "string" ? s.autoGpu : null,
      autoExtras: Array.isArray(s.autoExtras) ? [...new Set(s.autoExtras.filter(isExtra))] : null,
      renderScale: typeof s.renderScale === "number" && s.renderScale >= 0.25 && s.renderScale <= 2 ? s.renderScale : null,
      features,
    };
  } catch {
    return empty;
  }
}

export function loadStored(): StoredGfx {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return emptyStored();
  }
}

export function saveStored(s: StoredGfx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just don't persist */
  }
}

export function clearStored() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}

/**
 * The saved automatic tier, if it was measured on this backend and GPU. A result from WebGL2
 * isn't reused on WebGPU, and a software-rendered session (e.g. after a GPU-process crash)
 * doesn't pin Low once the real GPU is back.
 */
export function validAutoTier(s: StoredGfx, backend: string, gpu: string): Tier | null {
  return s.autoTier && s.autoBackend === backend && s.autoGpu === gpu ? s.autoTier : null;
}

/** The extras saved with that automatic tier (none when it doesn't apply here). */
export function validAutoExtras(s: StoredGfx, backend: string, gpu: string): Extra[] {
  return validAutoTier(s, backend, gpu) ? (s.autoExtras ?? []) : [];
}

/** Features forced off by `?no<feature>` URL flags (never persisted). */
export function killSwitches(): Set<Feature> {
  const off = new Set<Feature>();
  for (const f of FEATURES) if (flags.has(`no${f}`)) off.add(f);
  // ?nopost implies no post effects at all (tone mapping still runs).
  if (off.has("post")) for (const f of ["bloom", "ao", "traa", "fxaa", "grade", "grain", "vignette"] as const) off.add(f);
  if (off.has("sky")) off.add("skyplanets");
  if (off.has("particles")) off.add("motes");
  return off;
}

/** URL flags that force a feature on (opt-in experiments), e.g. `?traa`. */
function forcedOn(): Set<Feature> {
  const on = new Set<Feature>();
  for (const f of DEFAULT_OFF) if (flags.has(f)) on.add(f);
  return on;
}

export interface ResolvedSettings extends TierSpec {
  tier: Tier;
  /** True when the tier came from the probe (not pinned by the user or the URL). */
  auto: boolean;
  webgpu: boolean;
  /** Final on/off per feature after tier, backend gating, user toggles and kill switches. */
  on: Record<Feature, boolean>;
  /** User render-scale override (null = tier default). */
  userScale: number | null;
  /** The extras applied on top of the tier (D-framerate-3). */
  extras: Extra[];
}

/**
 * Resolve the effective settings. Order: tier table and its extras → backend gating (WebGPU-only
 * effects) → user toggles → URL kill switches.
 */
export function resolveSettings(tier: Tier, auto: boolean, webgpu: boolean, stored: StoredGfx, kills: Set<Feature>, extras: readonly Extra[] = []): ResolvedSettings {
  const list = EXTRAS.filter((e) => extras.includes(e));
  const spec = list.length ? withExtras(TIER_TABLE[tier], list) : TIER_TABLE[tier];
  const t = tierIndex(tier);
  const forced = forcedOn();
  const on = {} as Record<Feature, boolean>;
  for (const f of FEATURES) {
    let v = !DEFAULT_OFF.has(f);
    const user = stored.features[f];
    if (typeof user === "boolean") v = user;
    if (forced.has(f)) v = true;
    if (kills.has(f)) v = false;
    on[f] = v;
  }
  // Tier gating.
  on.fxaa &&= spec.post.fxaa;
  on.grain &&= spec.post.grain;
  on.vignette &&= spec.post.vignette;
  on.detail &&= spec.terrain.detailLayers > 0;
  // WebGPU-only extras on High/Ultra (SPEC §7.1, tech-facts §2).
  on.ao &&= webgpu && (t >= 2 || list.includes("ao")) && spec.post.ao !== "off";
  on.traa &&= webgpu && t >= 2 && spec.post.traa;
  // Post is the parent switch of every screen-space effect.
  if (!on.post) on.bloom = on.ao = on.traa = on.fxaa = on.grade = on.grain = on.vignette = false;
  // TRAA replaces FXAA.
  if (on.traa) on.fxaa = false;
  if (!on.sky) on.skyplanets = false;
  if (!on.particles) on.motes = false;
  // Cascaded sun shadows only on High/Ultra with shadow maps.
  on.cascades &&= on.shadows && spec.shadows.mode === "map" && t >= 2;
  return { ...spec, tier, auto, webgpu, on, userScale: stored.renderScale, extras: list };
}

/** URL-forced tier (`?tier=low|medium|high|ultra`), if any. */
export function urlTier(): Tier | null {
  const v = flags.get("tier");
  return isTier(v) ? v : null;
}

/** URL-forced extras (`?extras=normals,water2`, `?extras=none`), if any: measurement runs. */
export function urlExtras(): Extra[] | null {
  const v = flags.get("extras");
  if (v === null) return null;
  return v.split(",").filter(isExtra);
}

/** URL-forced render scale (`?scale=0.75`), if any. */
export function urlScale(): number | null {
  const v = Number(flags.get("scale"));
  return Number.isFinite(v) && v >= 0.25 && v <= 2 ? v : null;
}

// Player settings that are not graphics (graphics live in render/quality.ts, volumes in audio/Audio.ts,
// the voice opt-in in voice/VoiceClient.ts): mouse, field of view, comfort and damage numbers.
// Stored in localStorage as `fl.ui.v1`; every value is validated on load.

export interface UiSettings {
  v: 1;
  /** Mouse sensitivity multiplier (1 = the default 0.0022 rad per pixel). */
  sensitivity: number;
  invertY: boolean;
  /** Camera field of view in degrees. */
  fov: number;
  shake: boolean;
  damageNumbers: boolean;
  /** Colour-blind damage colours: yellow weak points, cyan shields (size and "!" always mark weak points). */
  cbDamage: boolean;
}

export const UI_DEFAULTS: Readonly<UiSettings> = Object.freeze({
  v: 1,
  sensitivity: 1,
  invertY: false,
  fov: 75,
  shake: true,
  damageNumbers: true,
  cbDamage: true,
}) as UiSettings;

export const SENSITIVITY_RANGE = [0.2, 3] as const;
export const FOV_RANGE = [60, 100] as const;
export const BASE_SENSITIVITY = 0.0022;

const KEY = "fl.ui.v1";

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Validate anything (parsed JSON, a partial patch) into a complete settings object. */
export function normalizeUiSettings(raw: unknown): UiSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<UiSettings>;
  const d = UI_DEFAULTS;
  return {
    v: 1,
    sensitivity: Math.round(clamp(r.sensitivity, SENSITIVITY_RANGE, d.sensitivity) * 100) / 100,
    invertY: bool(r.invertY, d.invertY),
    fov: Math.round(clamp(r.fov, FOV_RANGE, d.fov)),
    shake: bool(r.shake, d.shake),
    damageNumbers: bool(r.damageNumbers, d.damageNumbers),
    cbDamage: bool(r.cbDamage, d.cbDamage),
  };
}

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadUiSettings(store: Store | null = defaultStore()): UiSettings {
  try {
    const raw = store?.getItem(KEY);
    return normalizeUiSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeUiSettings(null);
  }
}

export function saveUiSettings(s: UiSettings, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings just don't persist */
  }
}

export type UiSettingsPatch = Partial<Omit<UiSettings, "v">>;

export function patchUiSettings(s: UiSettings, patch: UiSettingsPatch): UiSettings {
  return normalizeUiSettings({ ...s, ...patch });
}

// ------------------------------------------------------------------------------------------------ live store

type Listener = (s: UiSettings, prev: UiSettings) => void;
let current: UiSettings | null = null;
const listeners = new Set<Listener>();

export const uiSettings = {
  get(): UiSettings {
    return (current ??= loadUiSettings());
  },
  set(patch: UiSettingsPatch): UiSettings {
    const prev = uiSettings.get();
    current = patchUiSettings(prev, patch);
    saveUiSettings(current);
    for (const l of listeners) l(current, prev);
    return current;
  },
  reset(): UiSettings {
    const prev = uiSettings.get();
    current = normalizeUiSettings(null);
    saveUiSettings(current);
    for (const l of listeners) l(current, prev);
    return current;
  },
  /** Subscribe; returns an unsubscribe function. */
  onChange(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

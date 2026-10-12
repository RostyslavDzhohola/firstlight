import { describe, expect, it } from "vitest";
import { loadUiSettings, normalizeUiSettings, patchUiSettings, saveUiSettings, UI_DEFAULTS } from "./uiSettings.ts";

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("ui settings persistence", () => {
  it("returns defaults for empty, corrupt or foreign data", () => {
    expect(loadUiSettings(memStore())).toEqual(UI_DEFAULTS);
    expect(loadUiSettings(memStore({ "fl.ui.v1": "{nope" }))).toEqual(UI_DEFAULTS);
    expect(loadUiSettings(null)).toEqual(UI_DEFAULTS);
  });

  it("round-trips through storage", () => {
    const store = memStore();
    const s = patchUiSettings(UI_DEFAULTS, { sensitivity: 1.35, invertY: true, fov: 90, voice: { adult: true, enabled: true, mode: "vad" } });
    saveUiSettings(s, store);
    expect(loadUiSettings(store)).toEqual(s);
  });

  it("clamps numbers and rejects wrong types", () => {
    const s = normalizeUiSettings({ sensitivity: 99, fov: 10, invertY: "yes", shake: 0, voice: { mode: "shout" } });
    expect(s.sensitivity).toBe(3);
    expect(s.fov).toBe(60);
    expect(s.invertY).toBe(false);
    expect(s.shake).toBe(true);
    expect(s.voice.mode).toBe("ptt");
  });

  it("never enables voice without the 16+ opt-in", () => {
    expect(normalizeUiSettings({ voice: { enabled: true } }).voice.enabled).toBe(false);
    const on = patchUiSettings(UI_DEFAULTS, { voice: { adult: true, enabled: true } });
    expect(on.voice.enabled).toBe(true);
    expect(patchUiSettings(on, { voice: { adult: false } }).voice.enabled).toBe(false);
  });

  it("merges voice patches one level deep", () => {
    const s = patchUiSettings(patchUiSettings(UI_DEFAULTS, { voice: { adult: true, muteStrangers: true } }), { voice: { mode: "vad" } });
    expect(s.voice).toEqual({ adult: true, enabled: false, mode: "vad", muteStrangers: true });
  });
});

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
    const s = patchUiSettings(UI_DEFAULTS, { sensitivity: 1.35, invertY: true, fov: 90, cbDamage: false });
    saveUiSettings(s, store);
    expect(loadUiSettings(store)).toEqual(s);
  });

  it("clamps numbers and rejects wrong types", () => {
    const s = normalizeUiSettings({ sensitivity: 99, fov: 10, invertY: "yes", shake: 0 });
    expect(s.sensitivity).toBe(3);
    expect(s.fov).toBe(60);
    expect(s.invertY).toBe(false);
    expect(s.shake).toBe(true);
  });

  it("defaults the map settings for saves from before the minimap, and validates them", () => {
    const old = memStore({ "fl.ui.v1": JSON.stringify({ v: 1, sensitivity: 1.2, invertY: false, fov: 80, shake: true, damageNumbers: true, cbDamage: true }) });
    expect(loadUiSettings(old)).toMatchObject({ sensitivity: 1.2, minimap: true, minimapRotate: true, mapPlayerUp: false });
    expect(normalizeUiSettings({ minimap: "no", minimapRotate: 0, mapPlayerUp: true })).toMatchObject({ minimap: true, minimapRotate: true, mapPlayerUp: true });
  });

  it("keeps unrelated values when patching", () => {
    const s = patchUiSettings(patchUiSettings(UI_DEFAULTS, { fov: 88 }), { shake: false });
    expect(s).toMatchObject({ fov: 88, shake: false, sensitivity: 1 });
  });

});

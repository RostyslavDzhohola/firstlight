import { describe, expect, it } from "vitest";
import { preventsDefault } from "./input.ts";
import { BINDINGS, HOTKEYS, hits } from "./keys.ts";

describe("key bindings (SPEC §4.4, D-controls-2)", () => {
  it("bind no F-key: macOS keeps F1–F12 (F3 is Mission Control) and Fn may belong to another app", () => {
    for (const b of BINDINGS) expect(b.code, b.what).not.toMatch(/^F\d+$/);
    for (const k of Object.values(HOTKEYS)) expect(k.code).not.toMatch(/^F\d+$/);
  });

  it("every binding is its own key (with Shift counted)", () => {
    const seen = new Map<string, string>();
    for (const b of BINDINGS) {
      const id = `${b.shift ? "Shift+" : ""}${b.code}`;
      expect(seen.get(id), `${id}: ${b.what}`).toBeUndefined();
      seen.set(id, b.what);
    }
  });

  it("` opens the performance overlay, Shift+` the admin console; P takes a screenshot, Shift+P toggles photo mode", () => {
    expect(hits(HOTKEYS.perf, "Backquote", false)).toBe(true);
    expect(hits(HOTKEYS.perf, "Backquote", true)).toBe(false);
    expect(hits(HOTKEYS.adminConsole, "Backquote", true)).toBe(true);
    expect(hits(HOTKEYS.adminConsole, "Backquote", false)).toBe(false);
    expect(hits(HOTKEYS.screenshot, "KeyP", false)).toBe(true);
    expect(hits(HOTKEYS.screenshot, "KeyP", true)).toBe(false);
    expect(hits(HOTKEYS.photo, "KeyP", true)).toBe(true);
    expect(hits(HOTKEYS.photo, "KeyP", false)).toBe(false);
    expect(hits(HOTKEYS.perf, "F3", false)).toBe(false);
  });

  it("swallows the browser's default for play keys only while the pointer is locked, and leaves F-keys to the browser", () => {
    for (const code of ["Tab", "Space", "Slash", "Quote", "Backquote"]) {
      expect(preventsDefault(code, true), code).toBe(true);
      expect(preventsDefault(code, false), code).toBe(false);
    }
    for (const code of ["F3", "F5", "F9", "F11", "F12", "KeyW", "Escape"]) expect(preventsDefault(code, true), code).toBe(false);
  });
});

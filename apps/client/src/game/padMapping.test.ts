import { describe, expect, it } from "vitest";
import { SPELLS } from "@firstlight/shared/content/spells";
import { BINDINGS } from "./keys.ts";
import { BTN, hotbarStep, lookFromStick, PAD_LAYOUT, padControls, padFamily, padGlyph, shapeStick, type PadAction } from "./padMapping.ts";

const T = { deadzone: 0.15, curve: 1 };

describe("shapeStick: radial dead zone with rescaling (D-controls-5)", () => {
  it("reads zero inside the dead zone, in any direction", () => {
    expect(shapeStick(0.1, 0.1, T).mag).toBe(0);
    expect(shapeStick(-0.14, 0, T)).toEqual({ x: 0, y: 0, mag: 0 });
  });

  it("starts from zero at the edge of the dead zone (no jump) and reaches 1 at full throw", () => {
    expect(shapeStick(0.16, 0, T).mag).toBeCloseTo(0.01 / 0.85, 5);
    expect(shapeStick(1, 0, T).mag).toBeCloseTo(1);
  });

  it("keeps a diagonal's angle and never exceeds length 1 (corner throw on a square gate)", () => {
    const s = shapeStick(1, 1, T);
    expect(s.mag).toBeCloseTo(1);
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(1);
    expect(s.x).toBeCloseTo(s.y);
  });

  it("the response curve makes small pushes finer and leaves full throw alone", () => {
    const lin = shapeStick(0.5, 0, { deadzone: 0.1, curve: 1 }).mag;
    const curved = shapeStick(0.5, 0, { deadzone: 0.1, curve: 2 }).mag;
    expect(curved).toBeCloseTo(lin * lin);
    expect(shapeStick(1, 0, { deadzone: 0.1, curve: 2 }).mag).toBeCloseTo(1);
  });

  it("treats a broken axis (NaN) as centred", () => {
    expect(shapeStick(Number.NaN, 0, T).mag).toBe(0);
  });
});

describe("lookFromStick", () => {
  it("turns right for a right push and looks up for an up push (axis -1), scaled by dt and sensitivity", () => {
    const l = lookFromStick(1, -1, 0.1, 1, false);
    expect(l.yaw).toBeGreaterThan(0);
    expect(l.pitch).toBeGreaterThan(0);
    const fast = lookFromStick(1, 0, 0.1, 2, false);
    expect(fast.yaw).toBeCloseTo(l.yaw * 2);
  });

  it("invert Y flips pitch only", () => {
    const a = lookFromStick(0.5, -1, 0.1, 1, false);
    const b = lookFromStick(0.5, -1, 0.1, 1, true);
    expect(b.pitch).toBeCloseTo(-a.pitch);
    expect(b.yaw).toBeCloseTo(a.yaw);
  });

  it("the aim slowdown only scales the rate (no pull toward anything)", () => {
    const a = lookFromStick(0.5, 0.5, 0.1, 1, false, 1);
    const b = lookFromStick(0.5, 0.5, 0.1, 1, false, 0.6);
    expect(b.yaw / a.yaw).toBeCloseTo(0.6);
    expect(lookFromStick(0, 0, 0.1, 1, false, 0.6)).toEqual({ yaw: 0, pitch: -0 });
  });
});

describe("the pad layout (D-controls-5)", () => {
  const codes = new Set([...PAD_LAYOUT.values()].flatMap((a: PadAction) => (a.kind === "key" ? [a.code] : a.kind === "tapHold" ? [a.tap, a.hold] : [])));

  it("maps the brief's buttons", () => {
    expect(PAD_LAYOUT.get(BTN.A)).toEqual({ kind: "key", code: "Space" });
    expect(PAD_LAYOUT.get(BTN.B)).toEqual({ kind: "key", code: "KeyC" });
    expect(PAD_LAYOUT.get(BTN.X)).toEqual({ kind: "interact" });
    expect(PAD_LAYOUT.get(BTN.RT)).toEqual({ kind: "attack" });
    expect(PAD_LAYOUT.get(BTN.LT)).toEqual({ kind: "alt" });
    expect(PAD_LAYOUT.get(BTN.START)).toEqual({ kind: "key", code: "Escape" });
    expect(PAD_LAYOUT.get(BTN.SELECT)).toEqual({ kind: "select" });
    expect(PAD_LAYOUT.get(BTN.LS)).toEqual({ kind: "sprint" });
  });

  it("the D-pad casts every spell in the spellbook", () => {
    for (const s of SPELLS) expect(codes.has(s.code), s.name).toBe(true);
  });

  it("every key it sends is a play binding in keys.ts", () => {
    const bound = new Set(BINDINGS.map((b) => b.code));
    for (const c of codes) expect(bound.has(c), c).toBe(true);
  });

  it("reaches every play binding that matters, here or from the pause menu", () => {
    // Reached through context actions: E/R (X), Digit1–4 (LB/RB), Shift (LS click), M and Tab (Select).
    const viaContext = ["KeyE", "KeyR", "Digit1", "Digit2", "Digit3", "Digit4", "ShiftLeft", "ShiftRight", "KeyM", "Tab"];
    // Pause-menu rows for pads and touch (controls.ts): journal, tutorial checklist (and inventory, map, players again).
    const viaMenu = ["KeyJ", "KeyT"];
    // Keyboard-only by choice: photo, screenshot, perf/admin overlays, the phrase wheel, invites, voice.
    const keyboardOnly = ["KeyP", "Backquote", "KeyG", "KeyY", "KeyN", "KeyK", "KeyB", "KeyW", "KeyA", "KeyS", "KeyD"];
    for (const b of BINDINGS) {
      const ok = codes.has(b.code) || viaContext.includes(b.code) || viaMenu.includes(b.code) || keyboardOnly.includes(b.code);
      expect(ok, `${b.code} (${b.what})`).toBe(true);
    }
  });

  it("LB/RB step the hotbar and wrap", () => {
    expect(hotbarStep(0, 1)).toBe(1);
    expect(hotbarStep(3, 1)).toBe(0);
    expect(hotbarStep(0, -1)).toBe(3);
  });
});

describe("glyphs", () => {
  it("knows the three families by id", () => {
    expect(padFamily("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)")).toBe("xbox");
    expect(padFamily("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)")).toBe("playstation");
    expect(padFamily("Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)")).toBe("nintendo");
  });

  it("labels the same position with each maker's name", () => {
    expect(padGlyph("E", "xbox")).toBe("X");
    expect(padGlyph("E", "playstation")).toBe("□");
    expect(padGlyph("E", "nintendo")).toBe("Y");
    expect(padGlyph("Space", "playstation")).toBe("✕");
    expect(padGlyph("LMB", "xbox")).toBe("RT");
    expect(padGlyph("Q", "xbox")).toBe("D←");
  });

  it("WASD shows the stick once", () => {
    expect(["W", "A", "S", "D"].map((k) => padGlyph(k, "xbox"))).toEqual(["LS", null, null, null]);
  });

  it("the How to play list covers move, fight, world, spells and menus", () => {
    expect(padControls("xbox").map((g) => g.title)).toEqual(["Move", "Fight", "World", "Spells", "Menus"]);
  });
});

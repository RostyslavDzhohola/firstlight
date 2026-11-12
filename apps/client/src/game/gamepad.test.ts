// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturedFrom, Input } from "./input.ts";
import { GamepadSource, type PadLike, type PadSettings } from "./gamepad.ts";
import { BTN, SELECT_HOLD_MS } from "./padMapping.ts";
import type { FocusNav } from "../ui/focusNav.ts";

const SETTINGS: PadSettings = { deadzone: 0.15, curve: 1, sensitivity: 1, invertY: false, aimSlow: 1, rumble: true };

function pad(index = 0, id = "Xbox Wireless Controller"): PadLike & { press(b: number, on?: boolean): void; stick(i: number, x: number, y: number): void } {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  return {
    index,
    id,
    connected: true,
    mapping: "standard",
    axes,
    buttons,
    vibrationActuator: { playEffect: vi.fn(() => Promise.resolve("complete")) },
    press(b, on = true) {
      buttons[b] = { pressed: on, value: on ? 1 : 0 };
    },
    stick(i, x, y) {
      axes[i * 2] = x;
      axes[i * 2 + 1] = y;
    },
  };
}

function rig(opts: { prompt?: boolean; slot?: number } = {}) {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const input = new Input(canvas);
  input.free = true; // back in the game with the pointer free (pause state "free")
  const keys: { type: string; code: string; key: string }[] = [];
  const log = (e: Event) => keys.push({ type: e.type, code: (e as KeyboardEvent).code, key: (e as KeyboardEvent).key });
  window.addEventListener("keydown", log);
  window.addEventListener("keyup", log);
  const nav = { move: vi.fn(), accept: vi.fn(), scroll: vi.fn(), clearRing: vi.fn() } as unknown as FocusNav & { move: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> };
  const pads: (PadLike | null)[] = [];
  const src = new GamepadSource(
    { input, nav, settings: () => SETTINGS, interactAvailable: () => !!opts.prompt, selectedSlot: () => opts.slot ?? 0, onTarget: () => false },
    () => pads,
  );
  let t = 1000;
  const poll = (ms = 16) => src.poll((t += ms));
  const frame = () => input.endFrame();
  return { input, src, pads, keys, nav, poll, frame, dispose: () => (window.removeEventListener("keydown", log), window.removeEventListener("keyup", log)) };
}

describe("capturedFrom: the captured-input rule (D-controls-5)", () => {
  const base = { enabled: true, suspended: false, locked: false, free: false, device: "kbm" as const };
  it("pointer lock captures for every device", () => {
    expect(capturedFrom({ ...base, locked: true })).toBe(true);
  });
  it("back in the game with the pointer free: a pad or touch is captured, the mouse waits for its click", () => {
    expect(capturedFrom({ ...base, free: true })).toBe(false);
    expect(capturedFrom({ ...base, free: true, device: "pad" })).toBe(true);
    expect(capturedFrom({ ...base, free: true, device: "touch" })).toBe(true);
  });
  it("never under a menu, a panel or a loading screen", () => {
    expect(capturedFrom({ ...base, device: "pad" })).toBe(false); // the pause menu: not free
    expect(capturedFrom({ ...base, free: true, device: "pad", enabled: false })).toBe(false); // a panel
    expect(capturedFrom({ ...base, locked: true, suspended: true })).toBe(false); // loading
  });
});

describe("GamepadSource in play", () => {
  let r: ReturnType<typeof rig>;
  let p: ReturnType<typeof pad>;
  beforeEach(() => {
    r?.dispose();
    r = rig();
    p = pad();
    r.pads.push(p);
  });

  it("a press makes the pad the device; the game is then captured without pointer lock", () => {
    expect(r.input.captured).toBe(false);
    p.press(BTN.A);
    r.poll();
    expect(r.input.device).toBe("pad");
    expect(r.input.captured).toBe(true);
  });

  it("A jumps (Space as a key press the controller reads), released on let go", () => {
    p.press(BTN.A);
    r.poll();
    expect(r.input.pressed.has("Space")).toBe(true);
    expect(r.input.down("Space")).toBe(true);
    r.frame();
    p.press(BTN.A, false);
    r.poll();
    expect(r.input.down("Space")).toBe(false);
  });

  it("the left stick is an analog move (up is forward), dead zone applied", () => {
    p.stick(0, 0.05, -0.05);
    r.poll();
    expect(r.input.moveX).toBe(0);
    p.press(BTN.A); // be the device
    p.stick(0, 0, -0.6);
    r.poll();
    expect(r.input.moveY).toBeGreaterThan(0.4);
    expect(r.input.moveY).toBeLessThan(0.6);
    p.stick(0, 0, 0);
    r.poll();
    expect(r.input.moveY).toBe(0);
  });

  it("the right stick turns the camera (look radians for this frame)", () => {
    p.stick(1, 1, 0);
    r.poll();
    expect(r.input.lookYaw).toBeGreaterThan(0);
    r.frame();
    expect(r.input.lookYaw).toBe(0);
  });

  it("RT attacks (a fresh press counts as a click) and LT is the alt button", () => {
    p.press(BTN.RT);
    r.poll();
    expect(r.input.lmb).toBe(true);
    expect(r.input.lmbPressed).toBe(true);
    r.frame();
    r.poll();
    expect(r.input.lmbPressed).toBe(false); // held, not pressed again
    expect(r.input.lmb).toBe(true);
    p.press(BTN.LT);
    r.poll();
    expect(r.input.rmb).toBe(true);
  });

  it("X interacts when a prompt is up, otherwise reloads", () => {
    p.press(BTN.X);
    r.poll();
    expect(r.input.pressed.has("KeyR")).toBe(true);
    r.dispose();
    r = rig({ prompt: true });
    const q = pad();
    r.pads.push(q);
    q.press(BTN.X);
    r.poll();
    expect(r.input.pressed.has("KeyE")).toBe(true);
  });

  it("LB/RB pick the previous and next hotbar slot", () => {
    r.dispose();
    r = rig({ slot: 0 });
    const q = pad();
    r.pads.push(q);
    q.press(BTN.LB);
    r.poll();
    expect(r.input.pressed.has("Digit4")).toBe(true);
    q.press(BTN.LB, false);
    q.press(BTN.RB);
    r.poll();
    expect(r.input.pressed.has("Digit2")).toBe(true);
  });

  it("the D-pad casts the four spells (Q F X Z, left up right down)", () => {
    for (const [b, code] of [[BTN.LEFT, "KeyQ"], [BTN.UP, "KeyF"], [BTN.RIGHT, "KeyX"], [BTN.DOWN, "KeyZ"]] as const) {
      p.press(b);
      r.poll();
      expect(r.input.pressed.has(code), code).toBe(true);
      p.press(b, false);
      r.poll();
      r.frame();
    }
  });

  it("left stick click sprints until the stick comes back", () => {
    p.stick(0, 0, -1);
    p.press(BTN.LS);
    r.poll();
    expect(r.input.down("ShiftLeft")).toBe(true);
    p.press(BTN.LS, false);
    r.poll();
    expect(r.input.down("ShiftLeft")).toBe(true);
    p.stick(0, 0, 0);
    r.poll();
    expect(r.input.down("ShiftLeft")).toBe(false);
  });

  it("Start sends Esc (the pause menu); Select taps the map and a hold peeks the players list", () => {
    p.press(BTN.START);
    r.poll();
    expect(r.keys.some((k) => k.type === "keydown" && k.code === "Escape" && k.key === "Escape")).toBe(true);
    p.press(BTN.START, false);
    r.poll();
    r.keys.length = 0;
    p.press(BTN.SELECT);
    r.poll();
    p.press(BTN.SELECT, false);
    r.poll(50);
    expect(r.keys.filter((k) => k.code === "KeyM").map((k) => k.type)).toEqual(["keydown", "keyup"]);
    r.keys.length = 0;
    p.press(BTN.SELECT);
    r.poll();
    r.poll(SELECT_HOLD_MS + 10);
    expect(r.keys).toContainEqual({ type: "keydown", code: "Tab", key: "Tab" });
    p.press(BTN.SELECT, false);
    r.poll();
    expect(r.keys).toContainEqual({ type: "keyup", code: "Tab", key: "Tab" });
    expect(r.keys.some((k) => k.code === "KeyM")).toBe(false);
  });

  it("unplugged mid-play: nothing stays held (trigger, stick, sprint, keys)", () => {
    p.press(BTN.RT);
    p.press(BTN.A);
    p.stick(0, 0, -1);
    p.press(BTN.LS);
    r.poll();
    expect(r.input.lmb && r.input.down("Space") && r.input.down("ShiftLeft")).toBe(true);
    r.pads.length = 0;
    r.src.unplugged(0);
    expect(r.input.lmb).toBe(false);
    expect(r.input.down("Space")).toBe(false);
    expect(r.input.down("ShiftLeft")).toBe(false);
    expect(r.input.moveY).toBe(0);
  });

  it("two pads: either one plays; the one used last owns rumble", () => {
    const q = pad(1, "DualSense Wireless Controller Vendor: 054c");
    r.pads.push(q);
    q.press(BTN.A);
    r.poll();
    expect(r.input.pressed.has("Space")).toBe(true);
    expect(r.src.family).toBe("playstation");
    r.src.rumble(1, 1, 100);
    expect(q.vibrationActuator!.playEffect).toHaveBeenCalled();
    expect(p.vibrationActuator!.playEffect).not.toHaveBeenCalled();
  });

  it("the mouse taking over drops what the pad held", () => {
    p.press(BTN.RT);
    r.poll();
    expect(r.input.lmb).toBe(true);
    r.input.setDevice("kbm");
    r.poll();
    expect(r.input.lmb).toBe(false); // the trigger is still down, but the mouse is the device now
  });
});

describe("GamepadSource in menus", () => {
  it("out of play the pad moves the focus, A accepts, B and Start send Esc", () => {
    const r = rig();
    r.input.free = false; // the pause menu
    const p = pad();
    r.pads.push(p);
    p.press(BTN.DOWN);
    r.poll();
    expect(r.nav.move).toHaveBeenCalledWith("down");
    expect(r.input.pressed.size).toBe(0); // not a spell
    p.press(BTN.DOWN, false);
    p.press(BTN.A);
    r.poll();
    expect(r.nav.accept).toHaveBeenCalledTimes(1);
    expect(r.input.pressed.has("Space")).toBe(false);
    p.press(BTN.A, false);
    p.press(BTN.B);
    r.poll();
    expect(r.keys).toContainEqual({ type: "keydown", code: "Escape", key: "Escape" });
    r.dispose();
  });

  it("a held direction repeats after a pause", () => {
    const r = rig();
    r.input.free = false;
    const p = pad();
    r.pads.push(p);
    p.stick(0, 0, 0.9); // the stick pushed down
    r.poll();
    r.poll(100);
    expect(r.nav.move).toHaveBeenCalledTimes(1);
    r.poll(400);
    r.poll(120);
    expect(r.nav.move.mock.calls.length).toBeGreaterThanOrEqual(3);
    r.dispose();
  });
});

describe("Input device switching", () => {
  it("emulated mouse events right after a touch don't switch to the keyboard and mouse", () => {
    const canvas = document.createElement("canvas");
    const input = new Input(canvas);
    input.setDevice("touch");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    expect(input.device).toBe("touch");
  });

  it("a real mouse press switches back (and listeners hear it)", () => {
    const canvas = document.createElement("canvas");
    const input = new Input(canvas);
    const seen: string[] = [];
    input.onDeviceChange((d) => seen.push(d));
    input.setDevice("pad");
    canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    expect(input.device).toBe("kbm");
    expect(seen).toEqual(["pad", "kbm"]);
  });

  it("virtual keys are untrusted, so they never switch the device", () => {
    const input = new Input(document.createElement("canvas"));
    input.setDevice("pad");
    input.virtualKey("KeyE", true);
    expect(input.device).toBe("pad");
    expect(input.pressed.has("KeyE")).toBe(true);
  });

  it("touch never asks for pointer lock: the request reports refused, so the pause flow goes back to the game", () => {
    const el = document.createElement("canvas") as HTMLCanvasElement & { requestPointerLock: () => Promise<void> };
    let asked = 0;
    el.requestPointerLock = () => (asked++, Promise.resolve());
    const input = new Input(el);
    let refused = 0;
    input.onLockError = () => refused++;
    input.setDevice("touch");
    input.lock();
    expect(asked).toBe(0);
    expect(refused).toBe(1);
  });

  it("a page without the Pointer Lock API (iPhone Safari) reports refused instead of throwing", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "requestPointerLock", { value: undefined });
    const input = new Input(el);
    let refused = 0;
    input.onLockError = () => refused++;
    expect(() => input.lock()).not.toThrow();
    expect(refused).toBe(1);
  });

  it("two sticks (pad and touch) add up and clamp to length 1", () => {
    const input = new Input(document.createElement("canvas"));
    input.setMove("pad", 0, 0.8);
    input.setMove("touch", 0.8, 0);
    expect(Math.hypot(input.moveX, input.moveY)).toBeCloseTo(1);
    input.setMove("pad", 0, 0);
    expect(input.moveX).toBeCloseTo(0.8);
  });
});

describe("Input: held keys per source (review #4)", () => {
  it("a pad's Shift keyup doesn't cancel a sprint the keyboard still holds", () => {
    const r = rig();
    const p = pad();
    r.pads.push(p);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" })); // keyboard sprint
    p.stick(0, 0, -1);
    p.press(BTN.LS);
    r.poll();
    p.press(BTN.LS, false);
    p.stick(0, 0, 0); // the stick comes back: the pad's sprint latch lets go
    r.poll();
    expect(r.input.down("ShiftLeft")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" }));
    expect(r.input.down("ShiftLeft")).toBe(false);
    r.dispose();
  });

  it("the union: a key is down while any source holds it; clearing one source keeps the others", () => {
    const input = new Input(document.createElement("canvas"));
    input.virtualKey("Space", true, "touch");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    expect(input.down("Space")).toBe(true); // touch still holds it
    input.virtualKey("KeyW", true, "touch");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    input.clearKeys("touch");
    expect(input.down("Space")).toBe(false);
    expect(input.down("KeyW")).toBe(true); // the keyboard's own hold
    expect([...input.heldFrom("kbd")]).toEqual(["KeyW"]);
    input.clearKeys();
    expect(input.keys.size).toBe(0);
  });
});

describe("GamepadSource: two pads, one unplugged (review #2)", () => {
  it("unplugging pad A releases A's keys, sprint and Select while pad B keeps its own", () => {
    const r = rig();
    const a = pad(0);
    const b = pad(1);
    r.pads.push(a, b);
    a.stick(0, 0, -1);
    a.press(BTN.LS); // A sprints
    a.press(BTN.SELECT); // A starts a Select hold
    b.press(BTN.A); // B holds jump
    r.poll();
    expect(r.input.down("ShiftLeft") && r.input.down("Space")).toBe(true);
    r.pads.splice(0, 1);
    r.src.unplugged(0);
    expect(r.input.down("ShiftLeft")).toBe(false); // A's sprint latch let go
    expect(r.input.down("Space")).toBe(true); // B still holds its button
    expect(r.input.moveY).toBe(0); // A's stick no longer moves
    r.keys.length = 0;
    r.poll(SELECT_HOLD_MS + 10);
    expect(r.keys.some((k) => k.code === "Tab")).toBe(false); // A's Select hold died with it
    b.press(BTN.A, false);
    r.poll();
    expect(r.input.down("Space")).toBe(false);
    r.dispose();
  });
});

describe("GamepadSource: unplugged mid-charge (review #3)", () => {
  it("cancels alt instead of releasing it, so combat drops the charge", () => {
    const r = rig();
    const p = pad();
    r.pads.push(p);
    p.press(BTN.LT);
    r.poll();
    expect(r.input.rmb).toBe(true);
    r.pads.length = 0;
    r.src.unplugged(0);
    expect(r.input.rmb).toBe(false);
    expect(r.input.altCancelled).toBe(true);
    r.frame();
    expect(r.input.altCancelled).toBe(false);
    r.dispose();
  });

  it("an intentional let-go is a release, not a cancel", () => {
    const r = rig();
    const p = pad();
    r.pads.push(p);
    p.press(BTN.LT);
    r.poll();
    p.press(BTN.LT, false);
    r.poll();
    expect(r.input.rmb).toBe(false);
    expect(r.input.altCancelled).toBe(false);
    r.dispose();
  });

  it("a mouse still holding the right button means nothing is cancelled", () => {
    const input = new Input(document.createElement("canvas"));
    input.rmb = true;
    input.setButtons("pad:0", false, true);
    input.cancelButtons("pad:0");
    expect(input.rmb).toBe(true);
    expect(input.altCancelled).toBe(false);
  });
});

describe("Focus and visibility (review #1)", () => {
  it("blur clears every source at once and the game is no longer captured", () => {
    const r = rig();
    const p = pad();
    r.pads.push(p);
    p.press(BTN.LT);
    p.press(BTN.A);
    p.stick(0, 0, -1);
    r.poll();
    r.input.virtualKey("KeyW", true, "touch");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
    expect(r.input.captured && r.input.rmb && r.input.down("Space")).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(r.input.focused).toBe(false);
    expect(r.input.captured).toBe(false);
    expect(r.input.keys.size).toBe(0);
    expect(r.input.rmb).toBe(false);
    expect(r.input.altCancelled).toBe(true); // a charge is cancelled, not released
    expect(r.input.moveY).toBe(0);
    // Still unfocused: the pad feeds nothing, not even its held trigger.
    r.frame();
    r.poll();
    expect(r.input.rmb).toBe(false);
    expect(r.input.down("Space")).toBe(false);
    window.dispatchEvent(new Event("focus"));
    r.poll();
    // Back: the controls still held don't count until they return to neutral.
    expect(r.input.captured).toBe(true);
    expect(r.input.rmb).toBe(false);
    expect(r.input.down("Space")).toBe(false);
    expect(r.input.moveY).toBe(0);
    p.press(BTN.LT, false);
    p.press(BTN.A, false);
    p.stick(0, 0, 0);
    r.poll();
    p.press(BTN.A);
    r.poll();
    expect(r.input.down("Space")).toBe(true); // a fresh press counts again
    // A keyboard key held through the focus loss: its auto-repeat doesn't press it again.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", repeat: true }));
    expect(r.input.down("KeyD")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
    expect(r.input.down("KeyD")).toBe(true);
    r.dispose();
  });

  it("a hidden page counts as unfocused", () => {
    const input = new Input(document.createElement("canvas"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(input.focused).toBe(false);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(input.focused).toBe(document.hasFocus());
    window.dispatchEvent(new Event("focus"));
    expect(input.focused).toBe(true);
  });
});

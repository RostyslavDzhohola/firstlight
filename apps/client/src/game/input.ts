// The one input layer (D-controls-5): keyboard and mouse with pointer lock, plus what the gamepad
// (gamepad.ts) and the touch overlay (ui/touchOverlay.ts) feed in. Game code reads this each frame and
// never asks which device acted: buttons arrive as the same key events the keyboard sends
// (virtualKey), attack/alt as lmb/rmb, sticks and drags as an analog move vector and look radians.

import type { Hotkey } from "./keys.ts";
import { hits } from "./keys.ts";

/** Keys whose browser default (focus move, page scroll, a dead-key accent, quick find) must not act mid-game. */
const PLAY_KEYS: ReadonlySet<string> = new Set(["Tab", "Space", "Slash", "Quote", "Backquote"]);

/** Swallow the key's default while the pointer is locked (F-keys are left alone: the game binds none). */
export function preventsDefault(code: string, locked: boolean): boolean {
  return locked && PLAY_KEYS.has(code);
}

/** The device the player used last: picks glyphs, the touch overlay and the captured-input rule. */
export type Device = "kbm" | "pad" | "touch";

/** `key` values for codes virtual keys send (listeners that read `e.key` instead of `e.code`). */
const KEY_OF: Readonly<Record<string, string>> = { Escape: "Escape", Tab: "Tab", Space: " ", Enter: "Enter", ShiftLeft: "Shift", ShiftRight: "Shift" };
export function keyOf(code: string): string {
  if (KEY_OF[code]) return KEY_OF[code]!;
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

const EMPTY: ReadonlySet<string> = new Set();

/** Mouse events this soon after a touch are the browser's emulated ones, not a mouse. */
const TOUCH_MOUSE_MS = 900;
/** Mouse movement smaller than this (px in one event) doesn't switch the device (a nudged desk). */
const MOUSE_SWITCH_PX = 4;

/**
 * The game may act on look and attack input (D-controls-5): the pointer is locked, or the player is
 * back in the game with the pointer free (the "free" pause state) on a gamepad or touch, where there
 * is no pointer to lock. Never while a menu, panel or loading screen is up.
 */
export function capturedFrom(s: { enabled: boolean; suspended: boolean; locked: boolean; free: boolean; device: Device }): boolean {
  return s.enabled && !s.suspended && (s.locked || (s.free && s.device !== "kbm"));
}

/** The source of real keyboard events (virtual keys name theirs: "pad:0", "touch", "menu"). */
export const KEYBOARD = "kbd";

export class Input {
  /**
   * Keys held down: the union of every source's own held set (keyboard, each pad, touch). A key is
   * down while any source holds it; a keyup releases only the sending source's hold, so a pad's
   * synthetic Shift keyup can't cancel a sprint the keyboard still holds (review #4).
   */
  readonly keys = new Set<string>();
  private readonly heldBy = new Map<string, Set<string>>();
  /** The source of the virtual key being dispatched right now (null: a real keyboard event). */
  private dispatching: string | null = null;
  readonly pressed = new Set<string>(); // went down this frame
  /** Of `pressed`, the keys that went down with Shift held (read at the key press, not at the frame). */
  private readonly pressedShift = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  /** Mouse buttons (the pointer-lock rules below); gamepad and touch hold theirs in `virtualButtons`. */
  private mouseL = false;
  private mouseR = false;
  /** Attack (0) and alt (1) held by a gamepad or touch source, by source name. */
  private readonly virtualButtons = new Map<string, [boolean, boolean]>();
  /** Analog move from a stick (x right, y forward, length ≤ 1), by source name. */
  private readonly virtualMove = new Map<string, { x: number; y: number }>();
  lmbPressed = false;
  /**
   * Alt (the right button) went away this frame by cancellation, not by the player letting go: a pad
   * unplugged mid-charge, focus lost. Combat drops the charge, draw or guard instead of releasing it
   * (review #3). Cleared at endFrame.
   */
  altCancelled = false;
  /** Camera turn this frame from a stick or a drag, radians (+yaw turns right, +pitch looks up). */
  lookYaw = 0;
  lookPitch = 0;
  /** The device used last (see Device). */
  device: Device = "kbm";
  private readonly deviceListeners = new Set<(d: Device) => void>();
  private lastTouchAt = -Infinity;
  wheel = 0;
  locked = false;
  /**
   * Back in the game with the pointer free: the "Click to look around" hint (pause flow "free", set by
   * the Esc menu). Keys work as in play; only mouse-look waits for the click that locks the pointer.
   */
  free = false;
  /**
   * True while the game is loading (first arrival, travel, a rejoin, a graphics re-warm): Game sets
   * it. Keys that act in the world or open panels wait for the hand-over; nothing is buffered for it
   * (the paused frame loop and the hand-over end the input frame).
   */
  suspendedWhile: (() => boolean) | null = null;
  sensitivity = 0.0022;
  invertY = false;
  enabled = true;
  /** A lock request failed for good (after the raw-movement fallback): the pointer stays free. */
  onLockError: (() => void) | null = null;
  /** A promise-based request is in flight: its own outcome reports, not the pointerlockerror event. */
  private requesting = false;
  private requestedAt = 0;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (e.isTrusted) this.setDevice("kbm");
      if (!this.enabled) return;
      if (preventsDefault(e.code, this.locked)) e.preventDefault();
      if (!this.keys.has(e.code)) {
        this.pressed.add(e.code);
        if (e.shiftKey) this.pressedShift.add(e.code);
      }
      this.hold(this.dispatching ?? KEYBOARD, e.code, true);
    });
    window.addEventListener("keyup", (e) => this.hold(this.dispatching ?? KEYBOARD, e.code, false));
    window.addEventListener("blur", () => this.clearKeys(KEYBOARD));
    el.addEventListener("mousedown", (e) => {
      if (this.emulatedMouse()) return; // a tap on a touch screen: the touch overlay owns it
      this.setDevice("kbm");
      if (!this.locked) {
        this.lock();
        return;
      }
      if (e.button === 0) {
        this.mouseL = true;
        this.lmbPressed = true;
      }
      if (e.button === 2) this.mouseR = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => {
      if (this.device !== "kbm" && !this.emulatedMouse() && Math.abs(e.movementX) + Math.abs(e.movementY) >= MOUSE_SWITCH_PX) this.setDevice("kbm");
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener("wheel", (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) {
        this.clearKeys(KEYBOARD);
        this.mouseL = this.mouseR = false;
      }
    });
    // Browsers whose requestPointerLock returns nothing only report a refusal this way.
    document.addEventListener("pointerlockerror", () => {
      if (!this.requesting) this.onLockError?.();
    });
  }

  /** `source` holds (or let go of) `code`; `keys` stays the union of every source. */
  private hold(source: string, code: string, on: boolean): void {
    let set = this.heldBy.get(source);
    if (on) {
      if (!set) this.heldBy.set(source, (set = new Set()));
      set.add(code);
      this.keys.add(code);
      return;
    }
    if (!set?.delete(code)) return;
    for (const other of this.heldBy.values()) if (other.has(code)) return;
    this.keys.delete(code);
  }

  /** Let go of every key one source holds, or of every key of every source (a panel opened). */
  clearKeys(source?: string): void {
    if (source === undefined) {
      this.heldBy.clear();
      this.keys.clear();
      return;
    }
    const set = this.heldBy.get(source);
    if (!set) return;
    for (const code of [...set]) this.hold(source, code, false);
    this.heldBy.delete(source);
  }

  /** Keys one source holds right now (tests, diagnostics). */
  heldFrom(source: string): ReadonlySet<string> {
    return this.heldBy.get(source) ?? EMPTY;
  }

  /** Left mouse, or attack held on a gamepad or the touch overlay. */
  get lmb(): boolean {
    if (this.mouseL) return true;
    for (const b of this.virtualButtons.values()) if (b[0]) return true;
    return false;
  }
  set lmb(on: boolean) {
    this.mouseL = on;
  }

  /** Right mouse, or alt (aim, block, draw, charge) held on a gamepad or the touch overlay. */
  get rmb(): boolean {
    if (this.mouseR) return true;
    for (const b of this.virtualButtons.values()) if (b[1]) return true;
    return false;
  }
  set rmb(on: boolean) {
    this.mouseR = on;
  }

  /** A gamepad or touch source holds attack and alt (a fresh attack press also counts as lmbPressed). */
  setButtons(source: string, attack: boolean, alt: boolean) {
    const was = this.virtualButtons.get(source);
    if (attack && !was?.[0] && this.enabled) this.lmbPressed = true;
    if (!attack && !alt) this.virtualButtons.delete(source);
    else this.virtualButtons.set(source, [attack, alt]);
  }

  /**
   * A gamepad or touch source stops holding attack and alt without the player letting go (it was
   * unplugged, the page lost focus): if alt is no longer held by anyone, combat sees a cancel.
   */
  cancelButtons(source: string) {
    const b = this.virtualButtons.get(source);
    if (!b) return;
    this.virtualButtons.delete(source);
    if (b[1] && !this.rmb) this.altCancelled = true;
  }

  /** A stick's move vector (x right, y forward); length is clamped to 1. Zero clears the source. */
  setMove(source: string, x: number, y: number) {
    if (x === 0 && y === 0) this.virtualMove.delete(source);
    else this.virtualMove.set(source, { x, y });
  }

  /** Analog move from sticks (x right, y forward, length ≤ 1): zero when none is pushed. */
  get moveX(): number {
    return this.move().x;
  }
  get moveY(): number {
    return this.move().y;
  }
  private move(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const m of this.virtualMove.values()) {
      x += m.x;
      y += m.y;
    }
    const l = Math.hypot(x, y);
    return l > 1 ? { x: x / l, y: y / l } : { x, y };
  }

  /** Add camera turn for this frame (radians; +yaw right, +pitch up). Only counts while captured. */
  addLook(yaw: number, pitch: number) {
    this.lookYaw += yaw;
    this.lookPitch += pitch;
  }

  /**
   * A gamepad or touch button acting as a key: the same keydown/keyup the keyboard sends, dispatched
   * at the focused element so every listener (this class, panels, the pause menu, the players list)
   * reacts as it does to the key. Untrusted, so it never switches the device back to the keyboard.
   */
  virtualKey(code: string, down: boolean, source = "virtual") {
    if (typeof document === "undefined") return;
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    const was = this.dispatching;
    this.dispatching = source;
    try {
      target?.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code, key: keyOf(code), bubbles: true, cancelable: true }));
    } finally {
      this.dispatching = was;
    }
  }

  /** The device used last changed: glyphs, the touch overlay and the captured rule follow. */
  setDevice(d: Device) {
    if (d === "touch") this.lastTouchAt = performance.now();
    if (d === this.device) return;
    this.device = d;
    for (const l of this.deviceListeners) l(d);
  }

  onDeviceChange(fn: (d: Device) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  private emulatedMouse(): boolean {
    return performance.now() - this.lastTouchAt < TOUCH_MOUSE_MS;
  }

  lock() {
    // Touch looks by dragging, and phones without the Pointer Lock API (iPhone Safari) have nothing to
    // ask for: report it as refused, so the pause flow goes back to the game ("free"), where touch is captured.
    if (this.device === "touch" || typeof this.el.requestPointerLock !== "function") {
      if (!this.locked) this.onLockError?.();
      return;
    }
    // One request at a time (a double click asks once); a request that never settles stops blocking after 2 s.
    if (this.locked || (this.requesting && performance.now() - this.requestedAt < 2000)) return;
    const call = (...opts: [object?]) => (this.el.requestPointerLock as (o?: object) => Promise<void> | void).call(this.el, ...opts);
    const first = call({ unadjustedMovement: true });
    if (!first || typeof (first as Promise<void>).then !== "function") return; // older API: events report
    this.requesting = true;
    this.requestedAt = performance.now();
    const refused = () => this.onLockError?.();
    (first as Promise<void>)
      .catch((e: unknown) => {
        // Raw mouse movement isn't available everywhere: fall back to ordinary pointer lock.
        if ((e as { name?: string } | null)?.name === "NotSupportedError") return Promise.resolve(call()).catch(refused);
        // Otherwise refused (no user gesture, or re-locking too soon after Esc): the pointer stays free.
        refused();
      })
      .finally(() => (this.requesting = false));
  }

  /** The hotkey went down this frame (with Shift exactly as it wants, as it was at the key press). */
  hit(k: Hotkey): boolean {
    return this.enabled && this.pressed.has(k.code) && hits(k, k.code, this.pressedShift.has(k.code));
  }

  /**
   * The player is in the game: the pointer is locked, or free with the hint. Gate keys that act in
   * the world or open panels on this, not on `locked` (a refused or lost lock must not dead-key M, I,
   * J, T, E, 1–4, R or H). False while the pause menu, a panel, a notice or a loading screen is up.
   */
  get inPlay(): boolean {
    return this.enabled && !this.suspended && (this.locked || this.free);
  }

  /**
   * The game acts on look and attack input (capturedFrom): the pointer is locked, or a gamepad or
   * touch player is back in the game. Gate camera look and the mouse-button actions on this.
   */
  get captured(): boolean {
    return capturedFrom(this);
  }

  /** The game is loading (see suspendedWhile). */
  get suspended(): boolean {
    return this.suspendedWhile?.() ?? false;
  }

  down(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.pressedShift.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.lmbPressed = false;
    this.altCancelled = false;
    this.wheel = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
  }
}

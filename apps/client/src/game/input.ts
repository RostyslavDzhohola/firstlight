// Keyboard and mouse state with pointer lock. Game code reads this each frame.

import type { Hotkey } from "./keys.ts";
import { hits } from "./keys.ts";

/** Keys whose browser default (focus move, page scroll, a dead-key accent, quick find) must not act mid-game. */
const PLAY_KEYS: ReadonlySet<string> = new Set(["Tab", "Space", "Slash", "Quote", "Backquote"]);

/** Swallow the key's default while the pointer is locked (F-keys are left alone: the game binds none). */
export function preventsDefault(code: string, locked: boolean): boolean {
  return locked && PLAY_KEYS.has(code);
}

export class Input {
  readonly keys = new Set<string>();
  readonly pressed = new Set<string>(); // went down this frame
  mouseDX = 0;
  mouseDY = 0;
  lmb = false;
  rmb = false;
  lmbPressed = false;
  wheel = 0;
  locked = false;
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
      if (!this.enabled) return;
      if (preventsDefault(e.code, this.locked)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    el.addEventListener("mousedown", (e) => {
      if (!this.locked) {
        this.lock();
        return;
      }
      if (e.button === 0) {
        this.lmb = true;
        this.lmbPressed = true;
      }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => {
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
        this.keys.clear();
        this.lmb = this.rmb = false;
      }
    });
    // Browsers whose requestPointerLock returns nothing only report a refusal this way.
    document.addEventListener("pointerlockerror", () => {
      if (!this.requesting) this.onLockError?.();
    });
  }

  lock() {
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

  /** Shift is held. */
  shift(): boolean {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  /** The hotkey went down this frame (with Shift exactly as it wants). */
  hit(k: Hotkey): boolean {
    return this.enabled && this.pressed.has(k.code) && hits(k, k.code, this.shift());
  }

  down(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.lmbPressed = false;
    this.wheel = 0;
  }
}

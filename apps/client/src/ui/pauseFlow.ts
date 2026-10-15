// What the screen shows as the pointer lock comes and goes (D-controls-3): the pause menu, the game
// with a "Click to look around" hint, or nothing (playing, or a panel owns the screen). Pure: menu.ts
// feeds it pointer-lock changes, refused lock requests, Esc/Enter and overlay changes, and draws the
// state it reports. Browser rules it designs around (Chrome; others are stricter or equal):
//  - Esc is not a user gesture. After the browser's own Esc unlock, the page can't take the pointer
//    back until the next click, and Chrome refuses a re-lock for about a second after that Esc.
//  - A lock can be granted and lost again a few frames later (macOS drops it when the window stops
//    being the key window; a fullscreen change or the re-lock block can race it). The old menu
//    mirrored every pointerlockchange, so each such click blinked menu → game → menu.
//  - After the page frees the pointer itself (a panel opening, Esc under Keyboard Lock) it may take
//    it back without a gesture, so Esc can resume straight into the game there.

export type PauseState =
  /** Pointer locked: nothing drawn. */
  | "playing"
  /** Just unlocked: the menu shows if the unlock lasts (PAUSE_TIMING.menuDelayMs). Nothing drawn yet. */
  | "pending"
  /** The pause menu. */
  | "menu"
  /** Back in the game with the pointer free: the "Click to look around" hint; a click on the world locks. */
  | "free"
  /** A panel, the death screen, a sign-in card or a notice owns the screen (and its own Esc). */
  | "away";

export const PAUSE_TIMING = {
  /** An unlock must last this long before the menu shows: a lock that flickers off and on shows nothing. */
  menuDelayMs: 150,
  /** A lock lost sooner than this after it was granted didn't stick: back to the game with the hint, never the menu. */
  stickMs: 700,
};

export interface PauseClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface PauseHost {
  /** Draw `state` (called on every change). */
  render(state: PauseState): void;
  /** Ask for the pointer. It may be refused: then lockError() follows. */
  requestLock(): void;
  /** Free the pointer ourselves (Esc while locked only reaches the page under Keyboard Lock). */
  exitLock(): void;
  /** A panel, death screen, sign-in card or notice is open. */
  overlayOpen(): boolean;
}

const realClock: PauseClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class PauseFlow {
  state: PauseState = "away";
  private locked = false;
  private lockedAt = -Infinity;
  private suppressed = false;
  /** We freed the pointer to open the menu (Esc under Keyboard Lock): the unlock opens it at once. */
  private menuOnUnlock = false;
  private timer: unknown = null;

  constructor(private readonly host: PauseHost, private readonly clock: PauseClock = realClock) {}

  /** The pointer is locked (pointerlockchange). */
  onLocked(): void {
    this.locked = true;
    this.lockedAt = this.clock.now();
    this.menuOnUnlock = false;
    this.set("playing");
  }

  /** The pointer is free (pointerlockchange). */
  onUnlocked(): void {
    this.locked = false;
    if (this.blocked()) return this.set("away");
    if (this.menuOnUnlock) {
      this.menuOnUnlock = false;
      return this.set("menu");
    }
    // A lock that didn't stick isn't a pause: stay in the game with the hint (no blink).
    if (this.clock.now() - this.lockedAt < PAUSE_TIMING.stickMs) return this.set("free");
    this.set("pending");
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.state === "pending") this.set(this.blocked() ? "away" : "menu");
    }, PAUSE_TIMING.menuDelayMs);
  }

  /** A lock request was refused (no gesture, too soon after Esc, raw input unsupported…). */
  onLockError(): void {
    if (this.locked || this.state === "menu" || this.blocked()) return;
    this.set("free");
  }

  /** Esc (not a repeat). Returns true when handled (the caller may preventDefault). */
  onEscape(): boolean {
    if (this.blocked()) return false; // panels and cards handle their own Esc
    switch (this.state) {
      case "playing":
        if (!this.locked) return false;
        this.menuOnUnlock = true;
        this.host.exitLock();
        return true;
      case "menu":
        this.resume();
        return true;
      default: // pending, free, away with nothing open
        this.set("menu");
        return true;
    }
  }

  /** Enter or Space on the menu (both are user gestures, so the lock can be asked for at once). */
  onConfirm(): boolean {
    if (this.state !== "menu" || this.blocked()) return false;
    this.resume();
    return true;
  }

  /** Back to the game (Resume, a click on the menu's backdrop, Esc or Enter on the menu). */
  resume(): void {
    if (this.blocked()) return;
    this.set("free");
    this.host.requestLock();
  }

  /** An overlay opened or closed. */
  onOverlayChange(): void {
    if (this.locked || this.state === "menu") return; // a card over the menu leaves the menu under it
    if (this.blocked()) this.set("away");
    else if (this.state === "away") this.set("free");
  }

  /** A full-screen notice (logged out, connection lost…) owns the screen until it lets go. */
  suppress(on: boolean): void {
    this.suppressed = on;
    if (on) this.set("away");
    else if (!this.locked) this.set(this.host.overlayOpen() ? "away" : "free");
  }

  private blocked(): boolean {
    return this.suppressed || this.host.overlayOpen();
  }

  private set(state: PauseState): void {
    if (this.timer !== null && state !== "pending") {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (state === this.state) return;
    this.state = state;
    this.host.render(state);
  }
}

/** What pauseKey needs from a KeyboardEvent. */
export interface PauseKeyEvent {
  key: string;
  code: string;
  repeat: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Keys typed into these act on them (Enter on a button, Space in a field), not on the menu. */
export function isControl(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (!!el.isContentEditable || ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(el.tagName ?? ""));
}

/** The page's keydown (document): Esc toggles menu ↔ game; Enter or Space on the menu resumes. */
export function pauseKey(flow: PauseFlow, e: PauseKeyEvent): void {
  if (e.repeat || e.defaultPrevented) return; // holding Esc (to leave fullscreen) doesn't flip the menu
  if (e.key === "Escape") {
    if (flow.onEscape()) e.preventDefault();
  } else if ((e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") && !isControl(e.target) && flow.onConfirm()) {
    e.preventDefault();
    e.stopPropagation(); // not a jump on the way back
  }
}

/** Feed the flow from the page: pointer-lock changes (document) and refused lock requests (Input). */
export function bindPointerLock(
  flow: PauseFlow,
  doc: { addEventListener(type: "pointerlockchange", fn: () => void): void; readonly pointerLockElement: Element | null },
  input: { onLockError: (() => void) | null },
): void {
  doc.addEventListener("pointerlockchange", () => (doc.pointerLockElement ? flow.onLocked() : flow.onUnlocked()));
  input.onLockError = () => flow.onLockError();
}

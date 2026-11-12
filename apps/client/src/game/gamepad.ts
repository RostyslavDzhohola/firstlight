// The gamepad source (D-controls-5): polls the Gamepad API on its own animation frame (so menus work
// before the world loads and while the game loop is paused), and feeds Input: buttons as virtual keys,
// triggers as attack/alt, the left stick as an analog move, the right stick as look radians. Out of
// play (a menu, panel or card is up) the same pad drives FocusNav instead. The loop runs only while
// a pad is connected; a keyboard-and-mouse player pays nothing.

import type { Input } from "./input.ts";
import { BTN, hotbarStep, lookFromStick, PAD_LAYOUT, padFamily, SELECT_HOLD_MS, shapeStick, TRIGGER_ON, type Btn, type PadAction, type PadFamily, type StickTuning } from "./padMapping.ts";
import type { Dir, FocusNav } from "../ui/focusNav.ts";

export interface PadSettings extends StickTuning {
  /** Look speed multiplier (1 = LOOK_RATE). */
  sensitivity: number;
  invertY: boolean;
  /** Light look slowdown while the crosshair is on a creep (factor, 1 = off). */
  aimSlow: number;
  rumble: boolean;
}

export interface PadHost {
  input: Input;
  nav: FocusNav;
  settings(): PadSettings;
  /** An interaction prompt is up: X uses it (E) instead of reloading (R). */
  interactAvailable(): boolean;
  /** The hotbar's selected slot (0..3). */
  selectedSlot(): number;
  /** The crosshair is on a creep (for the aim slowdown). */
  onTarget(): boolean;
}

/** The slice of a browser Gamepad this reads (tests pass plain objects). */
export interface PadLike {
  index: number;
  id: string;
  connected: boolean;
  mapping: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
  vibrationActuator?: { playEffect?(type: string, params: object): Promise<unknown> } | null;
}

const NAV_REPEAT_FIRST_MS = 380;
const NAV_REPEAT_MS = 110;
/** A stick past this counts as a direction in menus. */
const NAV_STICK = 0.6;
/** Any stick past this (after the dead zone) or any button marks the pad as the active device. */
const ACTIVE_STICK = 0.25;

const SOURCE = "pad";

function pressedOf(p: PadLike, b: number): boolean {
  const x = p.buttons[b];
  if (!x) return false;
  return b === BTN.LT || b === BTN.RT ? x.value > TRIGGER_ON || (x.pressed && x.value === 0) : x.pressed;
}

/** What one pad holds: its buttons last poll, the keys it sent down, its sprint latch and Select. */
interface PadState {
  /** Input's source name for this pad ("pad:<index>"). */
  source: string;
  prev: boolean[];
  /** Key codes this pad holds down (sent keydown, owes keyup) and the button that holds each. */
  held: Map<string, number>;
  sprinting: boolean;
  selectAt: number;
  selectTab: boolean;
}

type Edge = { pad: PadLike; b: Btn; down: boolean };

export class GamepadSource {
  /** Per pad index: ownership of keys, sprint and Select (review #2: unplugging one pad releases only its own). */
  private readonly state = new Map<number, PadState>();
  private mode: "play" | "ui" | "idle" = "idle";
  /**
   * Pads that must come back to neutral (no button, sticks at rest) before they count again: every pad
   * when the window lost focus or the page was hidden (review #1).
   */
  private readonly waitNeutral = new Set<number>();
  private raf = 0;
  private last = 0;
  private navDir: Dir | null = null;
  private navNextAt = 0;
  /** The pad used last (rumble and glyphs follow it). */
  active: PadLike | null = null;
  family: PadFamily = "xbox";
  /** The family changed (a different pad took over): glyphs re-render. */
  onFamily: ((f: PadFamily) => void) | null = null;

  constructor(
    private readonly host: PadHost,
    private readonly pads: () => readonly (PadLike | null)[] = () => (typeof navigator !== "undefined" && navigator.getGamepads ? (navigator.getGamepads() as unknown as (PadLike | null)[]) : []),
  ) {}

  /** Start listening for pads (the loop runs while one is connected). */
  start(win: Window = window): void {
    win.addEventListener("gamepadconnected", () => this.wake());
    win.addEventListener("gamepaddisconnected", (e) => this.unplugged((e as GamepadEvent).gamepad?.index ?? -1));
    // A pad already connected (and used) before this page's listeners existed.
    if (this.connected().length) this.wake();
  }

  private wake(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = 0;
      this.poll(t);
      if (this.connected().length) this.raf = requestAnimationFrame(loop);
      else this.releaseAll();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private connected(): PadLike[] {
    return Array.from(this.pads()).filter((p): p is PadLike => !!p && p.connected);
  }

  private stateOf(index: number): PadState {
    let st = this.state.get(index);
    if (!st) this.state.set(index, (st = { source: `${SOURCE}:${index}`, prev: [], held: new Map(), sprinting: false, selectAt: 0, selectTab: false }));
    return st;
  }

  /** A pad went away: let go of everything it held (no stuck sprint, trigger, key or Select). */
  unplugged(index: number): void {
    this.releasePad(index, true);
    this.state.delete(index);
    if (this.active?.index === index) this.active = null;
    if (!this.connected().length) this.releaseAll();
  }

  /** One poll: `now` in ms. Public for tests. */
  poll(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const input = this.host.input;
    const s = this.host.settings();
    const all = this.connected().filter((p) => p.mapping === "standard" || p.buttons.length >= 16);
    if (!input.focused) {
      // Unfocused or hidden: feed nothing (not the world, not the menus); every pad waits for neutral.
      if (this.mode !== "idle") this.setMode("idle");
      for (const p of all) this.waitNeutral.add(p.index);
      return;
    }
    const pads = all.filter((p) => !this.waitNeutral.has(p.index) || this.neutral(p, s));
    let mx = 0, my = 0, lx = 0, ly = 0;
    const edges: Edge[] = [];
    let used: PadLike | null = null;
    const sticks = new Map<number, { mx: number; my: number; attack: boolean; alt: boolean }>();
    for (const p of pads) {
      const st = this.stateOf(p.index);
      const was = st.prev;
      const now2: boolean[] = [];
      for (let b = 0; b < Math.min(17, p.buttons.length); b++) {
        const on = pressedOf(p, b);
        now2[b] = on;
        if (on !== !!was[b]) edges.push({ pad: p, b: b as Btn, down: on });
        if (on && !was[b]) used = p; // a fresh press: a trigger still held from before doesn't claim the device back
      }
      st.prev = now2;
      const L = shapeStick(p.axes[0] ?? 0, p.axes[1] ?? 0, s);
      const R = shapeStick(p.axes[2] ?? 0, p.axes[3] ?? 0, s);
      if (L.mag > ACTIVE_STICK || R.mag > ACTIVE_STICK) used = p;
      mx += L.x;
      my += -L.y; // up on the stick is forward
      lx += R.x;
      ly += R.y;
      sticks.set(p.index, { mx: L.x, my: -L.y, attack: now2[BTN.RT] ?? false, alt: now2[BTN.LT] ?? false });
    }
    if (used) {
      if (this.active !== used) {
        this.active = used;
        const f = padFamily(used.id);
        if (f !== this.family) {
          this.family = f;
          this.onFamily?.(f);
        }
      }
      if (input.device !== "pad") input.setDevice("pad");
    }
    if (input.device !== "pad") {
      // The player went back to the mouse or the screen: drop whatever the pad held.
      if (this.mode !== "idle") this.setMode("idle");
      return;
    }
    const mode = input.captured ? "play" : "ui";
    if (mode !== this.mode) this.setMode(mode);
    if (mode === "play") {
      if (lx || ly) {
        const slow = s.aimSlow < 1 && this.host.onTarget() ? s.aimSlow : 1;
        const l = lookFromStick(lx, ly, dt, s.sensitivity, s.invertY, slow);
        input.addLook(l.yaw, l.pitch);
      }
      for (const p of pads) this.play(this.stateOf(p.index), edges, sticks.get(p.index)!, now);
    } else this.ui(edges, mx, my, ly, now, dt);
  }

  /** No button pressed and both sticks at rest: a waiting pad counts again, from a clean slate. */
  private neutral(p: PadLike, s: StickTuning): boolean {
    for (let b = 0; b < Math.min(17, p.buttons.length); b++) if (pressedOf(p, b)) return false;
    if (shapeStick(p.axes[0] ?? 0, p.axes[1] ?? 0, s).mag > 0 || shapeStick(p.axes[2] ?? 0, p.axes[3] ?? 0, s).mag > 0) return false;
    this.waitNeutral.delete(p.index);
    this.stateOf(p.index).prev = [];
    return true;
  }

  private setMode(m: "play" | "ui" | "idle"): void {
    if (this.mode === "play") this.releaseAll();
    if (m !== "ui") this.navDir = null;
    if (m !== "ui") this.host.nav.clearRing();
    this.mode = m;
  }

  private play(st: PadState, edges: Edge[], a: { mx: number; my: number; attack: boolean; alt: boolean }, now: number): void {
    const input = this.host.input;
    input.setMove(st.source, a.mx, a.my);
    input.setButtons(st.source, a.attack, a.alt);
    // Sprint lasts until this pad's stick comes back (as on most console games); a second click stops it.
    if (st.sprinting && Math.hypot(a.mx, a.my) < 0.2) this.setSprint(st, false);
    for (const e of edges) {
      if (this.state.get(e.pad.index) !== st) continue;
      const act = PAD_LAYOUT.get(e.b);
      if (act) this.act(st, act, e.b, e.down, now);
    }
    if (st.selectAt && !st.selectTab && now - st.selectAt >= SELECT_HOLD_MS) {
      st.selectTab = true;
      this.keyDown(st, "Tab", BTN.SELECT);
    }
  }

  private act(st: PadState, a: PadAction, b: Btn, down: boolean, now: number): void {
    switch (a.kind) {
      case "key":
        if (down) this.keyDown(st, a.code, b);
        else this.keyUpFrom(st, b);
        return;
      case "interact":
        if (down) this.keyDown(st, this.host.interactAvailable() ? "KeyE" : "KeyR", b);
        else this.keyUpFrom(st, b);
        return;
      case "hotbar":
        if (!down) return;
        this.tap(st, `Digit${hotbarStep(this.host.selectedSlot(), a.step) + 1}`);
        return;
      case "sprint":
        if (down) this.setSprint(st, !st.sprinting);
        return;
      case "select":
        if (down) {
          st.selectAt = now;
          st.selectTab = false;
        } else if (st.selectAt) {
          st.selectAt = 0;
          if (st.selectTab) this.keyUpFrom(st, BTN.SELECT);
          else this.tap(st, "KeyM");
          st.selectTab = false;
        }
        return;
      default:
        return; // attack and alt are read as held state
    }
  }

  private setSprint(st: PadState, on: boolean): void {
    if (on === st.sprinting) return;
    st.sprinting = on;
    this.host.input.virtualKey("ShiftLeft", on, st.source);
  }

  private keyDown(st: PadState, code: string, b: number): void {
    this.keyUpFrom(st, b);
    st.held.set(code, b);
    this.host.input.virtualKey(code, true, st.source);
  }

  private keyUpFrom(st: PadState, b: number): void {
    for (const [code, from] of st.held) {
      if (from !== b) continue;
      st.held.delete(code);
      this.host.input.virtualKey(code, false, st.source);
    }
  }

  private tap(st: { source: string } | null, code: string): void {
    const source = st?.source ?? SOURCE;
    this.host.input.virtualKey(code, true, source);
    this.host.input.virtualKey(code, false, source);
  }

  /**
   * Let go of what one pad holds: its keys, triggers, stick, sprint latch and Select. `cancel` (the pad
   * was unplugged, focus went): a held alt is cancelled, not released, so no charged heavy launches.
   */
  private releasePad(index: number, cancel = false): void {
    const st = this.state.get(index);
    if (!st) return;
    const input = this.host.input;
    for (const code of st.held.keys()) input.virtualKey(code, false, st.source);
    st.held.clear();
    this.setSprint(st, false);
    st.selectAt = 0;
    st.selectTab = false;
    input.setMove(st.source, 0, 0);
    if (cancel) input.cancelButtons(st.source);
    else input.setButtons(st.source, false, false);
  }

  /** Let go of every pad's held keys, triggers, sticks and sprint. */
  releaseAll(): void {
    for (const index of this.state.keys()) this.releasePad(index);
  }

  private ui(edges: Edge[], mx: number, my: number, ly: number, now: number, dt: number): void {
    const nav = this.host.nav;
    for (const e of edges) {
      if (!e.down) continue;
      if (e.b === BTN.A) nav.accept();
      // B backs out (Esc: every panel, card and the menu handle it); Start toggles the menu the same way.
      else if (e.b === BTN.B || e.b === BTN.START) this.tap(null, "Escape");
      else if (e.b === BTN.SELECT) this.tap(null, "KeyM"); // closes the map it opened
      else if (e.b === BTN.RS) this.tap(null, "KeyI"); // closes the inventory it opened
    }
    // Direction: the D-pad, or the left stick pushed well over.
    const btn = (b: number) => this.connected().some((p) => pressedOf(p, b));
    let dir: Dir | null = btn(BTN.UP) ? "up" : btn(BTN.DOWN) ? "down" : btn(BTN.LEFT) ? "left" : btn(BTN.RIGHT) ? "right" : null;
    if (!dir && Math.hypot(mx, my) > NAV_STICK) dir = Math.abs(mx) > Math.abs(my) ? (mx > 0 ? "right" : "left") : my > 0 ? "up" : "down";
    if (dir !== this.navDir) {
      this.navDir = dir;
      if (dir) {
        nav.move(dir);
        this.navNextAt = now + NAV_REPEAT_FIRST_MS;
      }
    } else if (dir && now >= this.navNextAt) {
      nav.move(dir);
      this.navNextAt = now + NAV_REPEAT_MS;
    }
    // Right stick scrolls long lists.
    if (Math.abs(ly) > 0.2) nav.scroll(ly * 900 * dt);
  }

  /** Rumble on the pad in use, where the browser supports it (Chrome, Edge; not Firefox or Safari). */
  rumble(strong: number, weak: number, ms: number): void {
    if (!this.host.settings().rumble || this.host.input.device !== "pad") return;
    const act = this.active?.vibrationActuator;
    void act?.playEffect?.("dual-rumble", { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {});
  }
}

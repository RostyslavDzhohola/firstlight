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

export class GamepadSource {
  /** Pressed state of each button last poll, per pad index. */
  private readonly prev = new Map<number, boolean[]>();
  /** Key codes this source holds down (sent keydown, owes keyup). */
  private readonly held = new Map<string, number>();
  private mode: "play" | "ui" | "idle" = "idle";
  private raf = 0;
  private last = 0;
  private selectAt = 0;
  private selectTab = false;
  private sprinting = false;
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

  /** A pad went away mid-play: let go of everything it held (no stuck sprint, trigger or key). */
  unplugged(index: number): void {
    this.prev.delete(index);
    if (this.active?.index === index) this.active = null;
    if (!this.connected().length) this.releaseAll();
  }

  /** One poll: `now` in ms. Public for tests. */
  poll(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const input = this.host.input;
    const s = this.host.settings();
    const pads = this.connected().filter((p) => p.mapping === "standard" || p.buttons.length >= 16);
    let mx = 0, my = 0, lx = 0, ly = 0, attack = false, alt = false;
    const edges: { pad: PadLike; b: Btn; down: boolean }[] = [];
    let used: PadLike | null = null;
    for (const p of pads) {
      const was = this.prev.get(p.index) ?? [];
      const now2: boolean[] = [];
      for (let b = 0; b < Math.min(17, p.buttons.length); b++) {
        const on = pressedOf(p, b);
        now2[b] = on;
        if (on !== !!was[b]) edges.push({ pad: p, b: b as Btn, down: on });
        if (on && !was[b]) used = p; // a fresh press: a trigger still held from before doesn't claim the device back
      }
      this.prev.set(p.index, now2);
      const L = shapeStick(p.axes[0] ?? 0, p.axes[1] ?? 0, s);
      const R = shapeStick(p.axes[2] ?? 0, p.axes[3] ?? 0, s);
      if (L.mag > ACTIVE_STICK || R.mag > ACTIVE_STICK) used = p;
      mx += L.x;
      my += -L.y; // up on the stick is forward
      lx += R.x;
      ly += R.y;
      attack ||= now2[BTN.RT] ?? false;
      alt ||= now2[BTN.LT] ?? false;
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
    if (mode === "play") this.play(edges, { mx, my, lx, ly, attack, alt }, dt, now, s);
    else this.ui(edges, mx, my, ly, now, dt);
  }

  private setMode(m: "play" | "ui" | "idle"): void {
    if (this.mode === "play") this.releaseAll();
    if (m !== "ui") this.navDir = null;
    if (m !== "ui") this.host.nav.clearRing();
    this.mode = m;
  }

  private play(edges: { b: Btn; down: boolean }[], a: { mx: number; my: number; lx: number; ly: number; attack: boolean; alt: boolean }, dt: number, now: number, s: PadSettings): void {
    const input = this.host.input;
    input.setMove(SOURCE, a.mx, a.my);
    input.setButtons(SOURCE, a.attack, a.alt);
    if (a.lx || a.ly) {
      const slow = s.aimSlow < 1 && this.host.onTarget() ? s.aimSlow : 1;
      const l = lookFromStick(a.lx, a.ly, dt, s.sensitivity, s.invertY, slow);
      input.addLook(l.yaw, l.pitch);
    }
    // Sprint lasts until the stick comes back (as on most console games); a second click stops it.
    if (this.sprinting && Math.hypot(a.mx, a.my) < 0.2) this.setSprint(false);
    for (const e of edges) {
      const act = PAD_LAYOUT.get(e.b);
      if (act) this.act(act, e.b, e.down, now);
    }
    if (this.selectAt && !this.selectTab && now - this.selectAt >= SELECT_HOLD_MS) {
      this.selectTab = true;
      this.keyDown("Tab", BTN.SELECT);
    }
  }

  private act(a: PadAction, b: Btn, down: boolean, now: number): void {
    switch (a.kind) {
      case "key":
        if (down) this.keyDown(a.code, b);
        else this.keyUpFrom(b);
        return;
      case "interact":
        if (down) this.keyDown(this.host.interactAvailable() ? "KeyE" : "KeyR", b);
        else this.keyUpFrom(b);
        return;
      case "hotbar":
        if (!down) return;
        this.tap(`Digit${hotbarStep(this.host.selectedSlot(), a.step) + 1}`);
        return;
      case "sprint":
        if (down) this.setSprint(!this.sprinting);
        return;
      case "select":
        if (down) {
          this.selectAt = now;
          this.selectTab = false;
        } else if (this.selectAt) {
          this.selectAt = 0;
          if (this.selectTab) this.keyUpFrom(BTN.SELECT);
          else this.tap("KeyM");
          this.selectTab = false;
        }
        return;
      default:
        return; // attack and alt are read as held state
    }
  }

  private setSprint(on: boolean): void {
    if (on === this.sprinting) return;
    this.sprinting = on;
    this.host.input.virtualKey("ShiftLeft", on);
  }

  private keyDown(code: string, b: number): void {
    this.keyUpFrom(b);
    this.held.set(code, b);
    this.host.input.virtualKey(code, true);
  }

  private keyUpFrom(b: number): void {
    for (const [code, from] of this.held) {
      if (from !== b) continue;
      this.held.delete(code);
      this.host.input.virtualKey(code, false);
    }
  }

  private tap(code: string): void {
    this.host.input.virtualKey(code, true);
    this.host.input.virtualKey(code, false);
  }

  /** Let go of every held key, the triggers, the stick and sprint. */
  releaseAll(): void {
    const input = this.host.input;
    for (const code of this.held.keys()) input.virtualKey(code, false);
    this.held.clear();
    this.setSprint(false);
    this.selectAt = 0;
    this.selectTab = false;
    input.setMove(SOURCE, 0, 0);
    input.setButtons(SOURCE, false, false);
  }

  private ui(edges: { b: Btn; down: boolean }[], mx: number, my: number, ly: number, now: number, dt: number): void {
    const nav = this.host.nav;
    for (const e of edges) {
      if (!e.down) continue;
      if (e.b === BTN.A) nav.accept();
      // B backs out (Esc: every panel, card and the menu handle it); Start toggles the menu the same way.
      else if (e.b === BTN.B || e.b === BTN.START) this.tap("Escape");
      else if (e.b === BTN.SELECT) this.tap("KeyM"); // closes the map it opened
      else if (e.b === BTN.RS) this.tap("KeyI"); // closes the inventory it opened
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

// Touch controls (experimental, D-controls-6): a floating move stick on the left half, drag-to-look
// on the right half, and buttons for attack (hold to keep firing), alt, jump, dodge, interact (only
// while there is something to use), reload, the four spells (their cooldown sweeps copied from the
// HUD spell bar), map and menu. The HUD hotbar's slots take taps. Every touch goes through Input
// (setMove, addLook, setButtons, virtualKey), like the keyboard and the gamepad. Multi-touch: each
// pointer is tracked by id, so moving, looking and firing work together.

import "./touch.css";
import type { Input } from "../game/input.ts";
import { SPELLS } from "@firstlight/shared/content/spells";

/** Stick throw in px: a full push is this far from where the thumb landed. */
export const STICK_RADIUS = 56;
/** Pushed this far past the rim (× radius) the stick sprints. */
export const SPRINT_PAST = 1.35;
/** Look: radians per CSS pixel of drag at sensitivity 1 (a 300 px swipe turns about 100°). */
export const TOUCH_LOOK = 0.0058;

const SOURCE = "touch";

export interface TouchHost {
  input: Input;
  /** Look sensitivity multiplier (Settings: the mouse sensitivity) and invert. */
  look(): { sensitivity: number; invertY: boolean };
  /** An interaction prompt is up (the Use button shows). */
  interactAvailable(): boolean;
  /** The game takes play input right now (no menu, panel or loading screen). */
  playing(): boolean;
}

interface Track {
  kind: "stick" | "look" | "button";
  x: number;
  y: number;
  ox: number;
  oy: number;
  code?: string;
}

/**
 * The pointer logic, without the DOM: which pointer is the stick, which ones look, what each sends.
 * The overlay feeds it pointer events; tests feed it numbers.
 */
export class TouchSticks {
  private readonly tracks = new Map<number, Track>();
  private sprint = false;
  /** Where the stick's base sits (for drawing), or null. */
  stickBase: { x: number; y: number } | null = null;
  stickKnob: { x: number; y: number } | null = null;

  constructor(private readonly host: Pick<TouchHost, "input" | "look">, private width: () => number) {}

  /** A finger landed on the open screen (not a button): left half moves, right half looks. */
  down(id: number, x: number, y: number): "stick" | "look" | null {
    const leftHalf = x < this.width() * 0.5;
    const hasStick = [...this.tracks.values()].some((t) => t.kind === "stick");
    const kind = leftHalf && !hasStick ? "stick" : leftHalf ? null : "look";
    if (!kind) return null;
    this.tracks.set(id, { kind, x, y, ox: x, oy: y });
    if (kind === "stick") {
      this.stickBase = { x, y };
      this.stickKnob = { x, y };
    }
    return kind;
  }

  move(id: number, x: number, y: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    const dx = x - t.x;
    const dy = y - t.y;
    t.x = x;
    t.y = y;
    if (t.kind === "look") {
      const { sensitivity, invertY } = this.host.look();
      const k = TOUCH_LOOK * sensitivity;
      this.host.input.addLook(dx * k, (invertY ? dy : -dy) * k);
    } else if (t.kind === "stick") this.stick(t);
  }

  up(id: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    if (t.kind === "stick") {
      this.host.input.setMove(SOURCE, 0, 0);
      this.setSprint(false);
      this.stickBase = this.stickKnob = null;
    }
  }

  /** Let go of everything (the overlay hid: a menu opened, the page lost focus). */
  reset(): void {
    for (const id of [...this.tracks.keys()]) this.up(id);
    this.tracks.clear();
  }

  get active(): number {
    return this.tracks.size;
  }

  private stick(t: Track): void {
    const dx = t.x - t.ox;
    const dy = t.y - t.oy;
    const d = Math.hypot(dx, dy);
    const mag = Math.min(1, d / STICK_RADIUS);
    const nx = d > 0 ? dx / d : 0;
    const ny = d > 0 ? dy / d : 0;
    // A small dead zone: a resting thumb doesn't creep.
    const m = mag < 0.12 ? 0 : (mag - 0.12) / 0.88;
    this.host.input.setMove(SOURCE, nx * m, -ny * m);
    this.setSprint(d > STICK_RADIUS * SPRINT_PAST && -ny > 0.5);
    this.stickKnob = { x: t.ox + nx * Math.min(d, STICK_RADIUS), y: t.oy + ny * Math.min(d, STICK_RADIUS) };
  }

  private setSprint(on: boolean): void {
    if (on === this.sprint) return;
    this.sprint = on;
    this.host.input.virtualKey("ShiftLeft", on, SOURCE);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

type ButtonDef = { id: string; label: string; cls: string; press: (on: boolean) => void };

/** The overlay: shown on touch devices (coarse pointer) or with ?touch; hidden while not playing. */
export class TouchOverlay {
  readonly root: HTMLDivElement;
  readonly sticks: TouchSticks;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly use: HTMLButtonElement;
  private readonly spells: { b: HTMLButtonElement; src: () => HTMLElement | null; cls: string; cd: string; n: string }[] = [];
  private readonly portrait: HTMLElement;
  private shown = false;
  private raf = 0;
  private attack = false;
  private alt = false;
  private hotbarBound = new WeakSet<Element>();
  private readonly offDevice: () => void;

  constructor(private readonly host: TouchHost, parent: HTMLElement = document.body) {
    this.root = el("div", "fl-touch");
    this.root.dataset.e2e = "touch-overlay";
    this.root.hidden = true;
    this.sticks = new TouchSticks(host, () => this.root.clientWidth || innerWidth);
    const zone = el("div", "fl-touch__zone", this.root);
    this.base = el("div", "fl-touch__base", zone);
    this.knob = el("div", "fl-touch__knob", this.base);
    this.base.hidden = true;

    zone.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return; // desktop with ?touch: the mouse still clicks to lock
      host.input.setDevice("touch");
      const kind = this.sticks.down(e.pointerId, e.clientX, e.clientY);
      if (!kind) return;
      e.preventDefault();
      zone.setPointerCapture?.(e.pointerId);
      this.draw();
    });
    zone.addEventListener("pointermove", (e) => {
      this.sticks.move(e.pointerId, e.clientX, e.clientY);
      this.draw();
    });
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      zone.addEventListener(t, (e) => {
        this.sticks.up(e.pointerId);
        this.draw();
      });
    }

    // Top: map and menu.
    const top = el("div", "fl-touch__top", this.root);
    this.button(top, { id: "map", label: "Map", cls: "fl-touch__small", press: (on) => on && this.tap("KeyM") });
    this.button(top, { id: "bag", label: "Bag", cls: "fl-touch__small", press: (on) => on && this.tap("KeyI") });
    this.button(top, { id: "menu", label: "☰", cls: "fl-touch__small", press: (on) => on && this.tap("Escape") });
    // First / third person (V, D-view-fp-1).
    this.button(top, { id: "view", label: "View", cls: "fl-touch__small", press: (on) => on && this.tap("KeyV") });

    // Right cluster: fire, alt, jump, roll, use, reload.
    const pad = el("div", "fl-touch__actions", this.root);
    this.button(pad, { id: "fire", label: "Fire", cls: "fl-touch__fire", press: (on) => this.setAttack(on) });
    this.button(pad, { id: "alt", label: "Alt", cls: "fl-touch__alt", press: (on) => this.setAlt(on) });
    this.button(pad, { id: "jump", label: "Jump", cls: "fl-touch__jump", press: (on) => host.input.virtualKey("Space", on, SOURCE) });
    this.button(pad, { id: "roll", label: "Roll", cls: "fl-touch__roll", press: (on) => on && this.tap("KeyC") });
    this.button(pad, { id: "reload", label: "R", cls: "fl-touch__reload", press: (on) => on && this.tap("KeyR") });
    this.use = this.button(pad, { id: "use", label: "Use", cls: "fl-touch__use", press: (on) => host.input.virtualKey("KeyE", on, SOURCE) });
    this.use.hidden = true;

    // Spells: four buttons over the cluster, their state copied from the HUD's spell bar each frame.
    const sp = el("div", "fl-touch__spells", this.root);
    for (const s of SPELLS) {
      const b = this.button(sp, { id: `spell-${s.id}`, label: "", cls: "fl-touch__spell", press: (on) => host.input.virtualKey(s.code, on, SOURCE) });
      b.dataset.spell = s.id;
      el("i", "fl-touch__cd", b);
      el("span", "fl-touch__n", b);
      el("span", "fl-touch__sname", b, s.name.split(" ")[0]!);
      this.spells.push({ b, src: () => document.querySelector<HTMLElement>(`.fl-spell[data-spell="${s.id}"]`), cls: "", cd: "", n: "" });
    }

    this.portrait = el("div", "fl-touch__portrait", this.root);
    el("b", "", this.portrait, "Turn your device sideways");
    el("span", "", this.portrait, "FIRSTLIGHT plays in landscape.");

    // No page scroll, zoom, text selection or long-press menu over the game.
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    parent.appendChild(this.root);
    // Touch presentation (the HUD's spell bar gives way, hotbar slots take taps) follows the device
    // used last: a switch to the mouse or a pad brings the normal spell bar back (review #8).
    const mode = (d: string) => document.documentElement.classList.toggle("fl-touchmode", d === "touch");
    mode(host.input.device);
    this.offDevice = host.input.onDeviceChange(mode);
    window.addEventListener("blur", () => this.release());
    // Focus lost or the page hidden (Input clears every source): let go of every pointer too, so a
    // finger still down when the page comes back must lift before it moves or looks again.
    host.input.onFocusChange((on) => {
      if (!on) this.release();
    });
    // Any touch anywhere (a menu button, the HUD) makes touch the device again, so the overlay can't be
    // stranded hidden after a key or a mouse took over.
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") host.input.setDevice("touch");
    }, { capture: true });
  }

  /** Start the per-frame sync (visibility, Use, spell state). */
  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.release();
    this.root.remove();
    this.offDevice();
    document.documentElement.classList.remove("fl-touchmode");
  }

  /** One sync step (public for tests). */
  frame(): void {
    const show = this.host.playing();
    if (show !== this.shown) {
      this.shown = show;
      this.root.hidden = !show;
      if (!show) this.release();
    }
    if (!show) return;
    const use = this.host.interactAvailable();
    if (this.use.hidden === use) this.use.hidden = !use;
    for (const s of this.spells) {
      const src = s.src();
      if (!src) continue;
      // The spell's icon, copied once from the HUD bar (the same sprite).
      if (!s.b.querySelector(".fl-spell__icon")) {
        const icon = src.querySelector(".fl-spell__icon");
        if (icon) s.b.insertBefore(icon.cloneNode(true), s.b.firstChild);
      }
      const cls = ["is-ready", "is-cd", "is-locked", "is-short", "is-up"].find((c) => src.classList.contains(c)) ?? "";
      if (cls !== s.cls) {
        if (s.cls) s.b.classList.remove(s.cls);
        if (cls) s.b.classList.add(cls);
        s.cls = cls;
      }
      const cd = (src.querySelector(".fl-spell__cd") as HTMLElement | null)?.style.getPropertyValue("--cd") ?? "";
      if (cd !== s.cd) s.b.querySelector<HTMLElement>(".fl-touch__cd")!.style.setProperty("--cd", (s.cd = cd) || "0");
      const n = src.querySelector(".fl-spell__n")?.textContent ?? "";
      if (n !== s.n) s.b.querySelector(".fl-touch__n")!.textContent = s.n = n;
    }
    this.bindHotbar();
  }

  /** The HUD hotbar's slots take taps (Digit1–4), bound once per slot element. */
  private bindHotbar(): void {
    const slots = document.querySelectorAll<HTMLElement>(".fl-hotbar .fl-slot");
    slots.forEach((slot, i) => {
      if (this.hotbarBound.has(slot)) return;
      this.hotbarBound.add(slot);
      slot.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" || !document.documentElement.classList.contains("fl-touchmode")) return;
        e.preventDefault();
        this.host.input.setDevice("touch");
        this.tap(`Digit${i + 1}`);
      });
    });
  }

  private draw(): void {
    this.root.dataset.active = String(this.sticks.active); // pointers held (journeys read it)
    const b = this.sticks.stickBase;
    const k = this.sticks.stickKnob;
    this.base.hidden = !b;
    if (b && k) {
      this.base.style.transform = `translate(${b.x}px, ${b.y}px)`;
      this.knob.style.transform = `translate(${k.x - b.x}px, ${k.y - b.y}px)`;
    }
  }

  private button(parent: HTMLElement, d: ButtonDef): HTMLButtonElement {
    const b = el("button", `fl-touch__btn ${d.cls}`, parent, d.label);
    b.type = "button";
    b.dataset.touch = d.id;
    b.tabIndex = -1;
    let id: number | null = null;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== null) return;
      id = e.pointerId;
      b.setPointerCapture?.(e.pointerId);
      b.classList.add("is-down");
      this.host.input.setDevice("touch");
      d.press(true);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      b.classList.remove("is-down");
      d.press(false);
    };
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
    b.addEventListener("lostpointercapture", end);
    // A held button let go when the overlay hides.
    b.addEventListener("fl-release", () => {
      if (id === null) return;
      id = null;
      b.classList.remove("is-down");
      d.press(false);
    });
    return b;
  }

  private tap(code: string): void {
    this.host.input.virtualKey(code, true, SOURCE);
    this.host.input.virtualKey(code, false, SOURCE);
  }

  private setAttack(on: boolean): void {
    this.attack = on;
    this.host.input.setButtons(SOURCE, this.attack, this.alt);
  }

  private setAlt(on: boolean): void {
    this.alt = on;
    this.host.input.setButtons(SOURCE, this.attack, this.alt);
  }

  /** Let go of every held touch (sticks, buttons). */
  release(): void {
    this.sticks.reset();
    for (const b of this.root.querySelectorAll(".fl-touch__btn")) b.dispatchEvent(new Event("fl-release"));
    this.attack = this.alt = false;
    this.host.input.setButtons(SOURCE, false, false);
    this.draw();
  }
}

/** Touch controls are on: a coarse pointer without hover (phones, tablets), or ?touch. */
export function wantsTouch(search: string, mm: ((q: string) => { matches: boolean }) | undefined = typeof matchMedia === "function" ? matchMedia : undefined): boolean {
  const p = new URLSearchParams(search);
  if (p.has("notouch")) return false;
  if (p.has("touch")) return true;
  return !!mm?.("(pointer: coarse) and (hover: none)").matches;
}

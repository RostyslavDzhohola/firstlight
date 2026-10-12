// Phrase wheel (G): a radial menu of the six fixed phrases (no text chat). Hold G, move the mouse
// toward a phrase, release G (or click) to say it. A quick tap of G keeps the wheel open until you
// click, press 1–6, or tap G again. The camera holds still while the wheel is open. Plain DOM (D25).

import "./phraseWheel.css";
import { PHRASES } from "@firstlight/shared/net/protocol";
import type { Input } from "../game/input.ts";

const RING = 104; // px from the centre to each phrase
const DEAD = 16; // px of virtual cursor travel before a phrase lights up
const REACH = 70; // the virtual cursor is clamped to this radius
const TAP_MS = 220;
const STEP = 360 / PHRASES.length;

/** Which phrase a cursor offset points at (screen axes, y down; phrase 0 at the top, clockwise). */
export function wheelSector(dx: number, dy: number, count = PHRASES.length, dead = DEAD): number {
  if (Math.hypot(dx, dy) < dead) return -1;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0 = up
  return ((Math.round(deg / (360 / count)) % count) + count) % count;
}

export class PhraseWheel {
  open = false;
  private readonly root: HTMLDivElement;
  private readonly items: HTMLDivElement[] = [];
  private readonly cursor: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly say: (id: number) => void;
  private sticky = false;
  private openedAt = 0;
  private cx = 0;
  private cy = 0;
  private sel = -1;
  private savedSensitivity = 0;
  private swallowLmb = false;
  private input: Input | null = null;

  constructor(say: (id: number) => void) {
    this.say = say;
    this.root = document.createElement("div");
    this.root.className = "fl-wheel";
    this.center = document.createElement("div");
    this.center.className = "fl-wheel-center";
    this.root.appendChild(this.center);
    PHRASES.forEach((text, i) => {
      const it = document.createElement("div");
      it.className = "fl-wheel-item";
      const a = ((-90 + i * STEP) * Math.PI) / 180;
      it.style.transform = `translate(calc(-50% + ${(Math.cos(a) * RING).toFixed(1)}px), calc(-50% + ${(Math.sin(a) * RING).toFixed(1)}px))`;
      const n = document.createElement("b");
      n.textContent = String(i + 1);
      it.append(n, document.createTextNode(text));
      this.root.appendChild(it);
      this.items.push(it);
    });
    this.cursor = document.createElement("div");
    this.cursor.className = "fl-wheel-cursor";
    this.root.appendChild(this.cursor);
    document.body.appendChild(this.root);
  }

  /**
   * Call every frame before weapon input. Returns true while the wheel owns the mouse and keys
   * (weapons don't fire). `allowed` false (dead, menus) closes it.
   */
  update(input: Input, now: number, allowed: boolean): boolean {
    if (this.swallowLmb) {
      if (input.lmb) return true;
      this.swallowLmb = false;
    }
    if (!this.open) {
      if (allowed && input.locked && input.pressed.has("KeyG")) this.show(input, now);
      return this.open;
    }
    if (!allowed || !input.locked) {
      this.hide();
      return false;
    }
    this.cx += input.mouseDX;
    this.cy += input.mouseDY;
    const r = Math.hypot(this.cx, this.cy);
    if (r > REACH) {
      this.cx *= REACH / r;
      this.cy *= REACH / r;
    }
    this.select(wheelSector(this.cx, this.cy));
    this.cursor.style.transform = `translate(calc(-50% + ${this.cx.toFixed(1)}px), calc(-50% + ${this.cy.toFixed(1)}px))`;

    for (let i = 0; i < PHRASES.length; i++) {
      if (input.pressed.has(`Digit${i + 1}`)) {
        this.choose(i);
        return true;
      }
    }
    if (input.lmbPressed) {
      this.swallowLmb = true;
      if (this.sel >= 0) this.choose(this.sel);
      else this.hide();
      return true;
    }
    if (this.sticky) {
      if (input.pressed.has("KeyG")) this.hide();
    } else if (!input.down("KeyG")) {
      if (this.sel >= 0) this.choose(this.sel);
      else if (now - this.openedAt < TAP_MS) this.sticky = true;
      else this.hide();
    }
    return true;
  }

  private show(input: Input, now: number) {
    this.open = true;
    this.sticky = false;
    this.openedAt = now;
    this.cx = this.cy = 0;
    this.input = input;
    this.savedSensitivity = input.sensitivity;
    input.sensitivity = 0; // hold the camera while choosing
    this.select(-1);
    this.cursor.style.transform = "translate(-50%, -50%)";
    this.root.classList.add("on");
  }

  private choose(i: number) {
    this.say(i);
    this.hide();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    if (this.input) this.input.sensitivity = this.savedSensitivity;
    this.input = null;
    this.root.classList.remove("on");
  }

  private select(i: number) {
    if (i === this.sel && this.center.textContent) return;
    this.sel = i;
    this.items.forEach((it, j) => it.classList.toggle("sel", j === i));
    this.center.textContent = i >= 0 ? PHRASES[i]! : "Say…";
  }

  dispose() {
    this.hide();
    this.root.remove();
  }
}

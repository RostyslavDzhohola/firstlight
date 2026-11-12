// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "../game/input.ts";
import { STICK_RADIUS, TouchOverlay, TouchSticks, wantsTouch } from "./touchOverlay.ts";

function input() {
  const i = new Input(document.createElement("canvas"));
  i.free = true;
  return i;
}

const look = () => ({ sensitivity: 1, invertY: false });

describe("TouchSticks: pointer handling (D-controls-6)", () => {
  it("a thumb on the left half is a floating stick: push up is forward, scaled to the throw", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    expect(t.down(1, 100, 300)).toBe("stick");
    t.move(1, 100, 300 - STICK_RADIUS / 2);
    expect(i.moveY).toBeGreaterThan(0.3);
    expect(i.moveY).toBeLessThan(0.6);
    expect(i.moveX).toBeCloseTo(0);
    t.move(1, 100 + STICK_RADIUS * 3, 300);
    expect(i.moveX).toBeCloseTo(1); // clamped at the rim
    t.up(1);
    expect(i.moveX).toBe(0);
    expect(i.moveY).toBe(0);
  });

  it("a resting thumb doesn't creep (small dead zone)", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    t.down(1, 100, 300);
    t.move(1, 103, 302);
    expect(i.moveX).toBe(0);
    expect(i.moveY).toBe(0);
  });

  it("the right half looks by dragging (radians, right turns right, up looks up)", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    expect(t.down(2, 600, 200)).toBe("look");
    t.move(2, 650, 180);
    expect(i.lookYaw).toBeGreaterThan(0);
    expect(i.lookPitch).toBeGreaterThan(0);
  });

  it("move, look and a second look finger together, each by its own pointer id", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    t.down(1, 100, 300);
    t.down(2, 600, 200);
    t.move(1, 100, 240);
    t.move(2, 640, 200);
    expect(i.moveY).toBeGreaterThan(0.5);
    expect(i.lookYaw).toBeGreaterThan(0);
    // A second finger on the left half while the stick is held is ignored (one stick).
    expect(t.down(3, 120, 320)).toBeNull();
    t.up(2);
    expect(i.moveY).toBeGreaterThan(0.5); // lifting the look finger leaves the stick
    expect(t.active).toBe(1);
  });

  it("pushing well past the rim straight ahead sprints (Shift held), easing back stops it", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    t.down(1, 100, 300);
    t.move(1, 100, 300 - STICK_RADIUS * 1.6);
    expect(i.down("ShiftLeft")).toBe(true);
    t.move(1, 100, 300 - STICK_RADIUS * 0.8);
    expect(i.down("ShiftLeft")).toBe(false);
  });

  it("reset lets go of everything", () => {
    const i = input();
    const t = new TouchSticks({ input: i, look }, () => 800);
    t.down(1, 100, 300);
    t.move(1, 100, 200);
    t.reset();
    expect(i.moveY).toBe(0);
    expect(t.active).toBe(0);
  });
});

describe("TouchOverlay", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.className = "";
  });

  function overlay(opts: { playing?: boolean; prompt?: boolean } = {}) {
    const i = input();
    i.setDevice("touch");
    const state = { playing: opts.playing ?? true, prompt: opts.prompt ?? false };
    const o = new TouchOverlay({ input: i, look, interactAvailable: () => state.prompt, playing: () => state.playing });
    o.frame();
    return { i, o, state, btn: (id: string) => o.root.querySelector<HTMLButtonElement>(`[data-touch="${id}"]`)! };
  }

  const pointer = (type: string, id: number) => new PointerEvent(type, { pointerId: id, pointerType: "touch", bubbles: true, cancelable: true });

  it("Fire held keeps the attack button down (continuous fire); release lets go", () => {
    const { i, btn } = overlay();
    btn("fire").dispatchEvent(pointer("pointerdown", 5));
    expect(i.lmb).toBe(true);
    expect(i.lmbPressed).toBe(true);
    btn("fire").dispatchEvent(pointer("pointerup", 5));
    expect(i.lmb).toBe(false);
  });

  it("Fire and Alt held together by two fingers", () => {
    const { i, btn } = overlay();
    btn("fire").dispatchEvent(pointer("pointerdown", 5));
    btn("alt").dispatchEvent(pointer("pointerdown", 6));
    expect(i.lmb && i.rmb).toBe(true);
    btn("alt").dispatchEvent(pointer("pointerup", 6));
    expect(i.lmb).toBe(true);
    expect(i.rmb).toBe(false);
  });

  it("Jump, Roll and a spell send their keys", () => {
    const { i, btn, o } = overlay();
    btn("jump").dispatchEvent(pointer("pointerdown", 1));
    expect(i.down("Space")).toBe(true);
    btn("roll").dispatchEvent(pointer("pointerdown", 2));
    expect(i.pressed.has("KeyC")).toBe(true);
    const spell = o.root.querySelector<HTMLButtonElement>(".fl-touch__spell")!;
    spell.dispatchEvent(pointer("pointerdown", 3));
    expect([...i.pressed].some((c) => ["KeyQ", "KeyF", "KeyX", "KeyZ"].includes(c))).toBe(true);
  });

  it("Use shows only while there is something to use", () => {
    const { o, state, btn } = overlay();
    expect(btn("use").hidden).toBe(true);
    state.prompt = true;
    o.frame();
    expect(btn("use").hidden).toBe(false);
  });

  it("hides when play stops (a menu opened) and lets go of held buttons", () => {
    const { i, o, state, btn } = overlay();
    btn("fire").dispatchEvent(pointer("pointerdown", 5));
    state.playing = false;
    o.frame();
    expect(o.root.hidden).toBe(true);
    expect(i.lmb).toBe(false);
  });

  it("copies the HUD spell bar's state and cooldown sweep", () => {
    const hud = document.createElement("div");
    hud.innerHTML = `<div class="fl-spell is-cd" data-spell="skipstep"><span class="fl-spell__k">Q</span><div class="fl-spell__box"><i class="fl-spell__cd" style="--cd: 0.40"></i><span class="fl-spell__n">3.2</span></div></div>`;
    document.body.appendChild(hud);
    const { o } = overlay();
    o.frame();
    const b = o.root.querySelector<HTMLElement>('[data-spell="skipstep"]')!;
    expect(b.classList.contains("is-cd")).toBe(true);
    expect(b.querySelector<HTMLElement>(".fl-touch__cd")!.style.getPropertyValue("--cd")).toBe("0.40");
    expect(b.querySelector(".fl-touch__n")!.textContent).toBe("3.2");
  });
});

describe("wantsTouch", () => {
  const mm = (coarse: boolean) => () => ({ matches: coarse });
  it("on for a coarse pointer without hover, or ?touch; ?notouch wins", () => {
    expect(wantsTouch("", mm(true))).toBe(true);
    expect(wantsTouch("", mm(false))).toBe(false);
    expect(wantsTouch("?touch", mm(false))).toBe(true);
    expect(wantsTouch("?notouch", mm(true))).toBe(false);
  });
});

describe("fl-touchmode follows the active device (review #8)", () => {
  it("a switch to the mouse or a pad brings the normal spell bar back; touch again restores the touch layout", () => {
    const i = input();
    i.setDevice("touch");
    const o = new TouchOverlay({ input: i, look, interactAvailable: () => false, playing: () => true });
    const on = () => document.documentElement.classList.contains("fl-touchmode");
    expect(on()).toBe(true);
    i.setDevice("kbm");
    expect(on()).toBe(false);
    i.setDevice("pad");
    expect(on()).toBe(false);
    i.setDevice("touch");
    expect(on()).toBe(true);
    o.stop();
    expect(on()).toBe(false);
    i.setDevice("kbm");
    i.setDevice("touch");
    expect(on()).toBe(false); // stopped: no longer listening
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FocusNav, pickNext, type Box } from "./focusNav.ts";
import { glyphFor, GlyphSync } from "./glyphs.ts";

const b = (x: number, y: number, w = 100, h = 30): Box => ({ x, y, w, h });

describe("pickNext: spatial focus (D-controls-5)", () => {
  // A menu column and a side button.
  const column = [b(0, 0), b(0, 40), b(0, 80), b(200, 40, 60)];

  it("down goes to the next row below, up to the row above", () => {
    expect(pickNext(column[0]!, column, "down")).toBe(1);
    expect(pickNext(column[2]!, column, "up")).toBe(1);
  });

  it("prefers the row in line over a nearer control off to the side", () => {
    const from = b(0, 0);
    const list = [b(150, 25), b(0, 60)];
    expect(pickNext(from, list, "down")).toBe(1);
  });

  it("left/right move across columns", () => {
    expect(pickNext(column[1]!, column, "right")).toBe(3);
    expect(pickNext(column[3]!, column, "left")).toBe(1);
  });

  it("nothing ahead: -1 (the focus stays)", () => {
    expect(pickNext(column[2]!, column, "down")).toBe(-1);
    expect(pickNext(column[0]!, column, "left")).toBe(-1);
  });
});

/** happy-dom has no layout: give elements boxes by hand. */
function place(el: HTMLElement, x: number, y: number, w = 100, h = 30) {
  el.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
  el.getClientRects = () => [el.getBoundingClientRect()] as unknown as DOMRectList;
}

describe("FocusNav on a menu", () => {
  afterEach(() => document.body.replaceChildren());

  function menu() {
    const root = document.createElement("div");
    const items = ["Resume", "Settings", "Log out"].map((t, i) => {
      const btn = document.createElement("button");
      btn.textContent = t;
      if (i === 0) btn.className = "is-resume";
      place(btn, 0, i * 40);
      root.appendChild(btn);
      return btn;
    });
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "10";
    range.step = "1";
    range.value = "5";
    place(range, 0, 120);
    root.appendChild(range);
    const hidden = document.createElement("button");
    hidden.hidden = true;
    root.appendChild(hidden);
    document.body.appendChild(root);
    return { items, range, hidden };
  }

  it("the first press focuses the menu's Resume, with a visible ring", () => {
    const { items } = menu();
    const nav = new FocusNav();
    nav.move("down");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]!.classList.contains("fl-padfocus")).toBe(true);
  });

  it("moves down the list, skipping hidden controls, and A clicks", () => {
    const { items } = menu();
    const nav = new FocusNav();
    nav.focusFirst();
    nav.move("down");
    expect(document.activeElement).toBe(items[1]);
    expect(items[0]!.classList.contains("fl-padfocus")).toBe(false);
    let clicked = "";
    items[1]!.addEventListener("click", () => (clicked = "settings"));
    nav.accept();
    expect(clicked).toBe("settings");
  });

  it("left/right on a slider change its value (and fire input)", () => {
    const { range } = menu();
    const nav = new FocusNav();
    nav.focus(range);
    let fired = 0;
    range.addEventListener("input", () => fired++);
    nav.move("right");
    expect(range.value).toBe("6");
    nav.move("left");
    nav.move("left");
    expect(range.value).toBe("4");
    expect(fired).toBe(3);
    expect(document.activeElement).toBe(range);
  });

  it("A with nothing focused focuses first instead of clicking blind", () => {
    const { items } = menu();
    let clicked = 0;
    items[0]!.addEventListener("click", () => clicked++);
    new FocusNav().accept();
    expect(document.activeElement).toBe(items[0]);
    expect(clicked).toBe(0);
  });

  it("controls under a closed (hidden) panel are not targets", () => {
    const root = document.createElement("div");
    root.hidden = true;
    const btn = document.createElement("button");
    place(btn, 0, 0);
    root.appendChild(btn);
    document.body.appendChild(root);
    expect(new FocusNav().hasTargets()).toBe(false);
  });
});

describe("glyphs follow the device", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.className = "";
  });

  it("glyphFor: keyboard keeps the key, a pad shows its button, touch the button's word", () => {
    expect(glyphFor("E", "kbm")).toBeNull();
    expect(glyphFor("E", "pad", "xbox")).toBe("X");
    expect(glyphFor("E", "pad", "playstation")).toBe("□");
    expect(glyphFor("E", "touch")).toBe("Use");
    expect(glyphFor("P", "pad")).toBe(""); // no pad button: hidden
    expect(glyphFor("1", "pad", "xbox", "slot")).toBe("");
  });

  it("GlyphSync swaps the HUD prompt's keycap and the tutorial's, then back", async () => {
    const hud = document.createElement("div");
    hud.className = "fl-hud";
    hud.innerHTML = `<div class="fl-prompt"><span class="fl-key fl-key--lit">E</span><b>take</b></div>`;
    const onb = document.createElement("div");
    onb.className = "fl-onb";
    onb.innerHTML = `<span class="fl-keys"><span class="fl-key">W</span><span class="fl-key">A</span></span>`;
    const menu = document.createElement("div");
    menu.innerHTML = `<span class="fl-key">I</span>`; // a menu keycap stays the keyboard's
    document.body.append(hud, onb, menu);
    const sync = new GlyphSync();
    sync.set("pad", "xbox");
    const [e] = hud.querySelectorAll<HTMLElement>(".fl-key");
    const [w, a] = onb.querySelectorAll<HTMLElement>(".fl-key");
    expect(e!.dataset.glyph).toBe("X");
    expect(w!.dataset.glyph).toBe("LS");
    expect(a!.dataset.glyph).toBe("");
    expect(menu.querySelector<HTMLElement>(".fl-key")!.dataset.glyph).toBeUndefined();
    expect(document.documentElement.classList.contains("fl-glyphs")).toBe(true);
    // The prompt changes key while the pad is in use: the observer re-applies.
    e!.textContent = "Space";
    await new Promise((r) => setTimeout(r, 0));
    expect(e!.dataset.glyph).toBe("A");
    sync.set("kbm", "xbox");
    expect(e!.dataset.glyph).toBeUndefined();
    expect(document.documentElement.classList.contains("fl-glyphs")).toBe(false);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { SpellsYou } from "@firstlight/shared/content/spells";
import { SpellBook } from "../game/spellBook.ts";
import { slotLook, SpellBar } from "./spellBar.ts";

const T = 5_000_000;
const you = (over: Partial<SpellsYou> = {}): SpellsYou => ({ aether: 100, t: T, regenAt: 0, ready: [0, 0, 0, 0], ...over });

function mount() {
  const spells = document.createElement("div"), aether = document.createElement("div");
  document.body.append(spells, aether);
  const bar = new SpellBar(spells, aether);
  const slot = (id: string) => spells.querySelector<HTMLElement>(`[data-spell="${id}"]`)!;
  return { bar, spells, aether, slot };
}

describe("the HUD's spell bar", () => {
  it("draws four slots with their keycaps and icons, and an aether bar", () => {
    const { spells, aether } = mount();
    expect([...spells.querySelectorAll(".fl-spell__k")].map((e) => e.textContent)).toEqual(["Q", "F", "X", "Z"]);
    expect([...spells.querySelectorAll(".fl-spell__icon")].map((e) => e.className.match(/px-spell-\w+/)![0])).toEqual(["px-spell-skipstep", "px-spell-frostbloom", "px-spell-wishfall", "px-spell-glasswing"]);
    expect(aether.querySelector('[role="meter"]')!.getAttribute("aria-label")).toBe("Aether");
    expect(spells.querySelector('[data-e2e="spell-bar"]')).not.toBeNull();
  });

  it("a level-1 character: Skipstep ready, the rest locked with the level that opens them", () => {
    const { bar, slot } = mount();
    const book = new SpellBook();
    book.setYou(you(), 1);
    bar.update(book.view(T));
    expect(slot("skipstep").classList.contains("is-ready")).toBe(true);
    for (const [id, lv] of [["frostbloom", 3], ["wishfall", 6], ["glasswing", 9]] as const) {
      expect(slot(id).classList.contains("is-locked"), id).toBe(true);
      expect(slot(id).querySelector(".fl-spell__n")!.textContent).toBe(`Lv ${lv}`);
      expect(slot(id).querySelector<HTMLElement>(".fl-spell__lock")!.hidden).toBe(false);
    }
  });

  it("a cooldown shows seconds and a sweep that unwinds; then the slot is ready again", () => {
    const { bar, slot } = mount();
    const book = new SpellBook();
    book.setYou(you({ ready: [T + 6000, 0, 0, 0] }), 9);
    bar.update(book.view(T));
    const s = slot("skipstep");
    expect(s.classList.contains("is-cd")).toBe(true);
    expect(s.querySelector(".fl-spell__n")!.textContent).toBe("6");
    expect(s.querySelector<HTMLElement>(".fl-spell__cd")!.style.getPropertyValue("--cd")).toBe("1.00");
    bar.update(book.view(T + 4000));
    expect(s.querySelector(".fl-spell__n")!.textContent).toBe("2.0");
    expect(Number(s.querySelector<HTMLElement>(".fl-spell__cd")!.style.getPropertyValue("--cd"))).toBeCloseTo(0.34, 2);
    bar.update(book.view(T + 6001));
    expect(s.classList.contains("is-ready")).toBe(true);
    expect(s.classList.contains("is-cd")).toBe(false);
    expect(s.querySelector(".fl-spell__n")!.textContent).toBe("");
    expect(s.querySelector<HTMLElement>(".fl-spell__cd")!.style.getPropertyValue("--cd")).toBe("0.00");
  });

  it("the aether bar follows the book; a spell it can't pay for shows its price", () => {
    const { bar, aether, slot } = mount();
    const book = new SpellBook();
    book.setYou(you({ aether: 30, regenAt: T + 1500 }), 9);
    bar.update(book.view(T));
    expect(aether.querySelector<HTMLElement>(".fl-aebar i")!.style.getPropertyValue("--fill")).toBe("0.3");
    expect(aether.querySelector(".v")!.textContent).toBe("30");
    expect(slot("wishfall").classList.contains("is-short")).toBe(true);
    expect(slot("wishfall").querySelector(".fl-spell__n")!.textContent).toBe("45");
    expect(slot("frostbloom").classList.contains("is-ready")).toBe(true);
    bar.update(book.view(T + 1500 + 10_000));
    expect(aether.querySelector(".v")!.textContent).toBe("90");
    expect(slot("wishfall").classList.contains("is-ready")).toBe(true);
  });

  it("the ward's slot shows the shell while it is up", () => {
    expect(slotLook({ id: "glasswing", name: "Glasswing Ward", keycap: "Z", level: 9, locked: false, cooldown: 17, cooldownFrac: 0.9, short: false, ready: false, cost: 35 }, { hp: 41.6, max: 54, left: 3 })).toEqual({ cls: "is-up", text: "42", sweep: 0 });
  });

  it("writes nothing when nothing changed", () => {
    const { bar, spells, aether } = mount();
    const book = new SpellBook();
    book.setYou(you({ ready: [T + 6000, 0, 0, 0] }), 9);
    bar.update(book.view(T));
    let writes = 0;
    const obs = new MutationObserver((r) => (writes += r.length));
    obs.observe(spells, { subtree: true, attributes: true, childList: true, characterData: true });
    obs.observe(aether, { subtree: true, attributes: true, childList: true, characterData: true });
    bar.update(book.view(T));
    bar.update(book.view(T + 1)); // a millisecond later: the same hundredths, the same text
    return Promise.resolve().then(() => {
      obs.disconnect();
      expect(writes).toBe(0);
    });
  });
});

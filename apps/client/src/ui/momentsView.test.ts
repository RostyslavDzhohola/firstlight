// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARRIVAL_HOLD_MS, arrivalCard } from "./arrivalCard.ts";
import { feedText, FEED_MS } from "./eventFeed.ts";
import { levelMoments, medalMoment, missionMoments } from "./moments.ts";
import { MomentsHud } from "./momentsView.ts";

function mount() {
  document.body.replaceChildren();
  const mk = (cls: string) => {
    const e = document.createElement("div");
    e.className = cls;
    document.body.appendChild(e);
    return e;
  };
  const slots = { top: mk("top"), feed: mk("fl-feed"), layer: mk("layer") };
  // happy-dom has no Web Animations: the hit ring and kill mark only need the call to exist.
  (HTMLElement.prototype as unknown as { animate: unknown }).animate ??= () => ({});
  return { hud: new MomentsHud(slots), ...slots };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("banners on the HUD", () => {
  it("one at a time, in order, each announced once", () => {
    const { hud, top } = mount();
    const shown: string[] = [];
    hud.onShow = (m) => shown.push(m.title);
    hud.push(...levelMoments(2, 3), medalMoment("nope"), ...missionMoments("A3", 180, 60));
    hud.tick(0);
    expect([...top.querySelectorAll(".fl-moment:not(.is-out)")].map((e) => e.querySelector(".fl-moment__t")!.textContent)).toEqual(["Level 3"]);
    hud.tick(1000);
    expect(top.querySelectorAll(".fl-moment").length).toBe(1);
    hud.tick(10_000); // level leaves
    expect(top.querySelector(".fl-moment")!.classList.contains("is-out")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(top.querySelectorAll(".fl-moment").length).toBe(0);
    hud.tick(20_000); // the spell it unlocked, with its key
    const spell = top.querySelector<HTMLElement>(".fl-moment")!;
    expect(spell.dataset.kind).toBe("spell");
    expect(spell.querySelector(".fl-key")!.textContent).toBe("F");
    hud.tick(30_000);
    hud.tick(40_000);
    expect(top.querySelector(".fl-moment:not(.is-out) .fl-moment__t")!.textContent).toBe("The Big Lake");
    expect(shown).toEqual(["Level 3", "Frostbloom", "The Big Lake"]);
  });

  it("clearBanners takes the banner down and empties the queue", () => {
    const { hud, top } = mount();
    hud.push(...levelMoments(1, 2), ...missionMoments("A3", 180, 60));
    hud.tick(0);
    hud.clearBanners();
    expect(top.querySelector(".fl-moment")).toBeNull();
    hud.tick(60_000);
    expect(top.querySelector(".fl-moment")).toBeNull();
  });
});

describe("the arrival card", () => {
  it("shows the world, then leaves by itself; a second arrival replaces the first", () => {
    const { hud, layer } = mount();
    const box = layer.querySelector<HTMLElement>(".fl-arrive")!;
    expect(box.hidden).toBe(true);
    hud.arrival(arrivalCard("portus"));
    hud.arrival(arrivalCard("arcadia"));
    expect(box.hidden).toBe(false);
    expect(box.dataset.body).toBe("arcadia");
    expect(box.querySelector(".fl-arrive__name")!.textContent).toBe("Arcadia");
    expect(box.querySelector(".fl-arrive__sub")!.textContent).toContain("Levels 1–7");
    expect(box.querySelectorAll(".fl-arrive__name").length).toBe(1);
    vi.advanceTimersByTime(ARRIVAL_HOLD_MS + 10);
    expect(box.classList.contains("is-out")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(box.hidden).toBe(true);
    expect(box.childElementCount).toBe(0);
  });
});

describe("the event feed", () => {
  it("draws names in bold with the AI chip on agents, and takes old lines away", () => {
    const { hud, feed } = mount();
    hud.feed("hunt", feedText.wonGleam({ name: "Tin_Lantern", agent: true }, "The Swift Gleam"), 0);
    hud.feed("join", feedText.joined({ name: "Mossback" }), 0);
    const lines = [...feed.querySelectorAll<HTMLElement>(".fl-feed__line")];
    expect(lines.map((l) => l.title)).toEqual(["Tin_Lantern (AI) won The Swift Gleam", "Mossback arrived"]);
    expect(lines[0]!.querySelector("b")!.textContent).toBe("Tin_Lantern");
    expect(lines[0]!.querySelector(".fl-ai")!.textContent).toBe("AI");
    expect(lines[1]!.querySelector(".fl-ai")).toBeNull();
    hud.tick(FEED_MS + 1);
    expect(lines[1]!.classList.contains("is-out")).toBe(true);
    expect(lines[0]!.classList.contains("is-out")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(feed.querySelectorAll(".fl-feed__line").length).toBe(1);
  });
});

describe("the hit ring", () => {
  it("turns a wedge to the bearing, reuses one for hits from the same side, and never makes more than four", () => {
    const { hud, layer } = mount();
    const ring = layer.querySelector(".fl-hitfrom")!;
    hud.hitFrom(90, 0);
    hud.hitFrom(100, 10); // same side: the wedge turns, no second one
    expect(ring.children.length).toBe(1);
    expect((ring.children[0] as HTMLElement).style.getPropertyValue("--a")).toBe("100deg");
    for (const a of [180, 270, 0, 45, 135]) hud.hitFrom(a, 20);
    expect(ring.children.length).toBe(4);
    hud.kill();
    hud.kill(true);
    expect(layer.querySelector(".fl-killmark")!.classList.contains("is-boss")).toBe(true);
  });
});

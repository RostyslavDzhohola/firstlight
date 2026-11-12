// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BodyKey } from "./loading.ts";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStill, STILL_FADE_MS, STILL_HOLD_MS, STILLS, StillDeck, stillsSlideshow, type Still } from "./loadingStills.ts";

const mk = (id: string, body: BodyKey): Still => ({ id, body, caption: `${id} caption`, src: `/stills/${id}.webp` });
const SET: Still[] = [
  mk("p1", "portus"), mk("p2", "portus"), mk("p3", "portus"),
  mk("a1", "arcadia"), mk("a2", "arcadia"),
  mk("h1", "hollowmere"), mk("h2", "hollowmere"),
  mk("m1", "meridian"), mk("m2", "meridian"),
];
const ids = (d: StillDeck, n: number) => Array.from({ length: n }, () => d.next()?.id ?? null);

describe("StillDeck (which still comes next)", () => {
  it("travelling: the destination's own stills first, then the other bodies in turn", () => {
    const d = new StillDeck(SET);
    d.plan("arcadia");
    const seq = ids(d, SET.length);
    expect(seq.slice(0, 2)).toEqual(["a1", "a2"]);
    expect([...seq].sort()).toEqual(SET.map((s) => s.id).sort()); // every still once a round
    const bodies = seq.slice(2).map((id) => SET.find((s) => s.id === id)!.body);
    for (let i = 1; i < bodies.length; i++) expect(bodies[i], `${seq.slice(2)}`).not.toBe(bodies[i - 1]);
  });

  it("no destination yet (the first load): Portus first, where most first loads land", () => {
    const d = new StillDeck(SET);
    d.plan(null);
    const first = d.next()!.id;
    expect(SET.find((s) => s.id === first)!.body).toBe("portus");
    d.next(); // the one ahead
    // The pick screen, then the arrival in Portus: another of Portus' stills opens.
    d.plan("portus");
    const second = d.next()!.id;
    expect(second).toMatch(/^p/);
    expect(second).not.toBe(first);
  });

  it("turns over which of the destination's stills opens, load after load, and never repeats the one just shown", () => {
    const d = new StillDeck(SET);
    const openers: string[] = [];
    for (let i = 0; i < 3; i++) {
      d.plan("portus");
      openers.push(d.next()!.id);
    }
    expect(new Set(openers).size).toBe(3);
    // Coming back to a body whose opener would be the still on screen: another one opens.
    const e = new StillDeck([mk("a1", "arcadia"), mk("a2", "arcadia"), mk("m1", "meridian")]);
    e.plan("arcadia");
    expect(e.next()!.id).toBe("a1");
    e.plan("meridian");
    expect(e.next()!.id).toBe("m1");
    e.plan("meridian"); // m1 opens again, but it's on screen: the next one
    expect(e.next()!.id).not.toBe("m1");
  });

  it("goes round and round, skips a still that failed for good, and has nothing when all failed", () => {
    const d = new StillDeck(SET);
    d.plan("meridian");
    const round1 = ids(d, SET.length);
    d.failed(SET.find((s) => s.id === "h1")!);
    const round2 = ids(d, SET.length * 2);
    expect(round2).not.toContain("h1");
    expect(new Set(round2).size).toBe(SET.length - 1);
    expect(round1[0]).toBe("m1");
    for (const s of SET) d.failed(s);
    expect(d.next()).toBeNull();
    expect(new StillDeck([]).next()).toBeNull();
  });

  it("one still is shown again and again (nothing else to show)", () => {
    const d = new StillDeck([mk("p1", "portus")]);
    d.plan("arcadia");
    expect(ids(d, 3)).toEqual(["p1", "p1", "p1"]);
  });
});

describe("the stills slideshow (DOM)", () => {
  /** A loader the test settles by hand: one pending download per still asked for. */
  function loader() {
    const asked: { still: Still; signal: AbortSignal; ok: () => void; fail: () => void }[] = [];
    const load = (still: Still, signal: AbortSignal) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = document.createElement("img");
        img.alt = "";
        img.src = still.src;
        asked.push({ still, signal, ok: () => resolve(img), fail: () => reject(new Error("404")) });
      });
    /** Downloads asked for and not cancelled (settled ones included). */
    const live = () => asked.filter((a) => !a.signal.aborted);
    return { asked, load, live, last: () => asked.at(-1)! };
  }
  let box: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.head.querySelectorAll("style").forEach((e) => e.remove());
    document.body.replaceChildren();
    box = document.createElement("div");
    document.body.append(box);
  });
  afterEach(() => vi.useRealTimers());
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const figs = () => [...box.querySelectorAll<HTMLElement>("figure.fl-loading__still")];
  const on = () => box.querySelector<HTMLElement>("figure.is-on")?.dataset.still ?? null;
  const frames = () => vi.advanceTimersByTimeAsync(40); // two animation frames

  it("asks for one still at a time: the first at once, the next only once the first is up", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("hollowmere");
    expect(l.asked.map((a) => a.still.id)).toEqual(["h1"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(l.asked).toHaveLength(1); // nothing else while the first is on its way
    l.last().ok();
    await flush();
    await frames();
    expect(on()).toBe("h1");
    expect(show.shown()).toBe("h1");
    expect(l.asked.map((a) => a.still.id)).toEqual(["h1", "h2"]); // one ahead
    const fig = figs()[0]!;
    expect(fig.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(fig.querySelector("figcaption")!.textContent).toBe("h1 caption");
    expect(box.classList.contains("has-still")).toBe(true);
  });

  it("crossfades to the next after its time on screen; the old one goes once the fade is over", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("portus");
    l.last().ok();
    await flush();
    await frames();
    l.last().ok(); // the second is in early
    await flush();
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS - 200);
    expect(on()).toBe("p1");
    await vi.advanceTimersByTimeAsync(200);
    await frames();
    expect(on()).toBe(show.shown());
    expect(show.shown()).not.toBe("p1");
    expect(figs()).toHaveLength(2); // both while they fade
    await vi.advanceTimersByTimeAsync(STILL_FADE_MS + 100);
    expect(figs()).toHaveLength(1);
  });

  /** Up to the moment the second still fades in over the first (p1 → p2 in Portus). */
  async function toCrossfade() {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("portus");
    l.last().ok();
    await flush();
    await frames();
    l.last().ok();
    await flush();
    const old = figs()[0]!;
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS);
    await frames();
    expect(show.shown()).toBe("p2");
    return { old, show };
  }
  const css = (text: string) => {
    const st = document.createElement("style");
    st.textContent = text;
    document.head.append(st);
  };

  it("under reduced motion's slower fade (3 s, loading.css) the old still stays until its fade is over", async () => {
    css(".fl-loading__still { transition-duration: 3s; }");
    const { old } = await toCrossfade();
    expect(figs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(STILL_FADE_MS + 100);
    expect(old.isConnected).toBe(true); // mid-fade: not gone at the default 1.6 s
    await vi.advanceTimersByTimeAsync(3000 - STILL_FADE_MS);
    expect(figs()).toHaveLength(1);
    expect(old.isConnected).toBe(false);
  });

  it("the old still goes when its fade ends (transitionend), not later", async () => {
    css(".fl-loading__still { transition-duration: 3s; }");
    const { old } = await toCrossfade();
    old.querySelector("img")!.dispatchEvent(new Event("transitionend", { bubbles: true })); // a child's: not its fade
    expect(old.isConnected).toBe(true);
    const end = new Event("transitionend", { bubbles: true }) as Event & { propertyName?: string };
    Object.defineProperty(end, "propertyName", { value: "opacity" });
    old.dispatchEvent(end);
    expect(old.isConnected).toBe(false);
    expect(figs()).toHaveLength(1);
  });

  it("with no fade at all (transition-duration 0) it is a plain swap", async () => {
    css(".fl-loading__still { transition-duration: 0s; }");
    const { old } = await toCrossfade();
    expect(old.isConnected).toBe(false);
    expect(figs()).toHaveLength(1);
  });

  it("a destination change or a stop cancels the download on its way: one in flight at a time", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start(null);
    const first = l.last();
    expect(first.still.body).toBe("portus");
    show.body("meridian"); // while the first is still on its way
    expect(first.signal.aborted).toBe(true);
    expect(l.last().still.id).toBe("m1");
    expect(l.live().map((a) => a.still.id)).toEqual(["m1"]);
    show.body("arcadia");
    expect(l.live().map((a) => a.still.id)).toEqual(["a1"]);
    // A cancelled download that lands anyway (or fails) changes nothing, and isn't counted as broken.
    first.ok();
    l.asked[1]!.fail();
    await flush();
    await frames();
    expect(figs()).toHaveLength(0);
    expect(l.live().map((a) => a.still.id)).toEqual(["a1"]);
    show.stop();
    expect(l.live()).toHaveLength(0);
    show.start("meridian"); // opens on m2 this time (the deck turns over), then m1: not skipped as failed
    expect(l.last().still.id).toBe("m2");
    l.last().ok();
    await flush();
    await frames();
    expect(l.last().still.id).toBe("m1");
  });

  it("keeps the still up until a slow next one arrives, then swaps", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("arcadia");
    l.last().ok();
    await flush();
    await frames();
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS * 3);
    expect(on()).toBe("a1");
    l.last().ok();
    await flush();
    await frames();
    expect(on()).toBe("a2");
  });

  it("skips a still that fails to load, silently", async () => {
    const l = loader();
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("meridian");
    l.last().fail(); // m1 is broken
    await flush();
    expect(l.last().still.id).toBe("m2");
    l.last().ok();
    await flush();
    await frames();
    expect(on()).toBe("m2");
    expect(figs()).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // And never asks for it again.
    for (let i = 0; i < SET.length * 2; i++) {
      l.last().ok();
      await flush();
      await vi.advanceTimersByTimeAsync(STILL_HOLD_MS);
    }
    expect(l.asked.filter((a) => a.still.id === "m1")).toHaveLength(1);
  });

  it("stops when the loader hides: no more downloads, a late one is not shown, the pictures go", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start("portus");
    l.last().ok();
    await flush();
    await frames();
    show.stop();
    expect(figs()).toHaveLength(0);
    expect(box.classList.contains("has-still")).toBe(false);
    l.last().ok(); // the one ahead lands after the hand-over
    await flush();
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS * 2);
    expect(figs()).toHaveLength(0);
    expect(l.asked).toHaveLength(2);
    // The next full load starts again.
    show.start("arcadia");
    expect(l.last().still.id).toBe("a1");
  });

  it("learning the destination mid-load: the next still is from there", async () => {
    const l = loader();
    const show = stillsSlideshow(box, { stills: SET, load: l.load });
    show.start(null); // "Loading the game…": not known yet
    l.last().ok();
    await flush();
    await frames();
    expect(SET.find((s) => s.id === on())!.body).toBe("portus");
    show.body("meridian"); // "Travelling to Meridian…"
    expect(l.last().still.id).toBe("m1");
    l.last().ok();
    await flush();
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS);
    await frames();
    expect(on()).toBe("m1");
    // The same destination again changes nothing.
    const n = l.asked.length;
    show.body("meridian");
    expect(l.asked).toHaveLength(n);
  });

  it("with no stills there is nothing to do", async () => {
    const show = stillsSlideshow(box, { stills: [] });
    show.start("portus");
    await vi.advanceTimersByTimeAsync(STILL_HOLD_MS * 2);
    expect(box.children).toHaveLength(0);
    expect(show.shown()).toBeNull();
  });
});

describe("loadStill (the browser's download and decode)", () => {
  /** An Image stand-in: its request is out while it has a src; decode() settles by hand. */
  class FakeImage {
    static made: FakeImage[] = [];
    alt = "";
    decoding = "";
    style = {};
    private attrs = new Map<string, string>();
    settle: { ok: () => void; fail: (e: unknown) => void } | null = null;
    constructor() {
      FakeImage.made.push(this);
    }
    get src() {
      return this.attrs.get("src") ?? "";
    }
    set src(v: string) {
      this.attrs.set("src", v);
    }
    setAttribute(k: string, v: string) {
      this.attrs.set(k, v);
    }
    getAttribute(k: string) {
      return this.attrs.get(k) ?? null;
    }
    removeAttribute(k: string) {
      this.attrs.delete(k);
      this.settle?.fail(new Error("EncodingError")); // a browser fails the decode of a dropped request
    }
    decode() {
      return new Promise<void>((ok, fail) => (this.settle = { ok, fail }));
    }
  }
  beforeEach(() => {
    FakeImage.made = [];
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks at low priority and resolves with the decoded image", async () => {
    const p = loadStill(mk("p1", "portus"));
    const img = FakeImage.made[0]!;
    expect(img.getAttribute("fetchpriority")).toBe("low");
    expect(img.src).toBe("/stills/p1.webp");
    img.settle!.ok();
    await expect(p).resolves.toBe(img);
  });

  it("cancelled: the request is dropped (no src) and it rejects as aborted", async () => {
    const ac = new AbortController();
    const p = loadStill(mk("p1", "portus"), ac.signal);
    const img = FakeImage.made[0]!;
    ac.abort();
    expect(img.getAttribute("src")).toBeNull();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // Already cancelled: nothing is asked for.
    await expect(loadStill(mk("p2", "portus"), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeImage.made).toHaveLength(1);
  });
});

describe("STILLS (the pictures that ship)", () => {
  it("are 6–10 in-game stills, at least one per body, each with a short caption naming the place", () => {
    expect(STILLS.length).toBeGreaterThanOrEqual(6);
    expect(STILLS.length).toBeLessThanOrEqual(10);
    for (const b of ["portus", "arcadia", "hollowmere", "meridian"] as const) expect(STILLS.some((s) => s.body === b), b).toBe(true);
    expect(new Set(STILLS.map((s) => s.id)).size).toBe(STILLS.length);
    for (const s of STILLS) {
      expect(s.id.startsWith(`${s.body}-`), s.id).toBe(true);
      expect(s.caption.length, s.id).toBeLessThanOrEqual(30);
      expect(s.caption, s.id).toMatch(/^[A-Z]/);
    }
  });

  it("are small WebP files next to the code (≤ 120 KB each, so the first comes in fast at low priority)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "stills");
    for (const s of STILLS) {
      expect(s.src, s.id).toMatch(new RegExp(`/stills/${s.id}\\.webp$`)); // Vite hashes it in the build
      const file = join(dir, `${s.id}.webp`);
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, s.id).toBeLessThanOrEqual(120 * 1024);
    }
  });
});

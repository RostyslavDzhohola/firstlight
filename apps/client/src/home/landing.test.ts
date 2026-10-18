// @vitest-environment happy-dom
// The home page under the loading screen (#21, D-home-8): once the loader has been on screen for a
// frame, the landing is taken out of the page (not displayed, inert) and the home page stops polling;
// the way back (a failed load's "Back to the home page") brings it back working, with fresh data.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withStylesheet } from "../ui/stylesheet.testutil.ts";

vi.mock("../net/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../net/auth.ts")>();
  return { ...real, isDevGuest: () => false, saveStatus: vi.fn(async () => "none"), onAccountChange: vi.fn(() => () => {}) };
});

const MARKUP = `
    <section id="landing" data-e2e="home">
      <button id="play"><span id="play-label">Play</span></button>
      <ul id="home-online-list"></ul><span id="home-online-total"></span>
      <div id="home-board"></div><div id="home-worlds"></div><div id="home-visits" hidden></div>
    </section>
    <div id="ui"><section class="fl-me"></section></div>
    <div id="loading" hidden></div>`;

let homeCalls = 0;
beforeAll(() => {
  history.replaceState(null, "", "/");
  document.body.innerHTML = MARKUP;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/home")) homeCalls++;
      return new Response("{}", { status: 503 });
    }),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const landing = () => document.getElementById("landing")!;
const displayed = () => landing().style.display !== "none";

describe("the landing under the loading screen", () => {
  it("goes only after the loader has had a frame on screen, then is not displayed and inert", async () => {
    const { hideLandingUnderLoader } = await import("./landing.ts");
    const frames: (() => void)[] = [];
    hideLandingUnderLoader(landing(), (fn) => frames.push(fn));
    expect(displayed(), "the same frame the loader appears in").toBe(true);
    frames.shift()!();
    expect(displayed(), "the loader's first frame").toBe(true);
    frames.shift()!();
    expect(displayed()).toBe(false);
    expect(landing().inert).toBe(true);
  });

  it("comes back displayed and interactive, and a hide still waiting for its frames is dropped", async () => {
    const { hideLandingUnderLoader, showLanding } = await import("./landing.ts");
    showLanding(landing());
    expect(displayed()).toBe(true);
    expect(landing().inert).toBe(false);
    const frames: (() => void)[] = [];
    hideLandingUnderLoader(landing(), (fn) => frames.push(fn));
    frames.shift()!();
    showLanding(landing()); // a load failed at once: back to the home page
    while (frames.length) frames.shift()!();
    expect(displayed()).toBe(true);
    expect(landing().inert).toBe(false);
  });

  it("back on the home page, the half-started game's UI layer (HUD) stays hidden until Play again", async () => {
    // .fl-home sits at z 0, so #ui (the HUD a failed boot already built) would paint over the page.
    const { hideLandingUnderLoader, showLanding } = await import("./landing.ts");
    const card = document.querySelector("#ui .fl-me")!;
    const seen = () => getComputedStyle(card).visibility !== "hidden";
    await withStylesheet("ui/styles/home.css", () => {
      hideLandingUnderLoader(landing(), (fn) => fn());
      expect(seen(), "in the game").toBe(true);
      showLanding(landing());
      expect(seen(), "over the home page").toBe(false);
      hideLandingUnderLoader(landing(), (fn) => fn());
      expect(seen(), "Play again").toBe(true);
    }).finally(() => showLanding(landing()));
  });

  it("the home page polls nothing while it is hidden, and polls at once when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { hideLandingUnderLoader, showLanding } = await import("./landing.ts");
    const { initHome } = await import("./home.ts");
    await initHome();
    await vi.waitFor(() => expect(homeCalls).toBe(1));
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(homeCalls).toBe(2)); // polling while shown

    hideLandingUnderLoader(landing(), (fn) => fn());
    expect(displayed()).toBe(false);
    // A poll decides synchronously: it calls fetch before its first await. So every tick of six poll
    // periods and a tab switch back (which polls at once) have had their say when these return.
    await vi.advanceTimersByTimeAsync(120_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(homeCalls, "no polling under the loader").toBe(2);

    showLanding(landing());
    await vi.waitFor(() => expect(homeCalls, "fresh data on the way back").toBe(3));
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(homeCalls, "polling again").toBe(4));
  });
});

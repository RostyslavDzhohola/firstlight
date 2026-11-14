// @vitest-environment happy-dom
// The home page's hero and the sections under it (D-home-9…11): the stills' cross-fade, the world
// cards (their stills stay put across polls), "New in the worlds" with the hunt's public state.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeOnline } from "@firstlight/shared/net/home";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { SPELLS } from "@firstlight/shared/content/spells";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { STILLS } from "../ui/loadingStills.ts";
import { paintAgentsSwitch, renderAgentCommands, renderNews, renderOnline, renderWorlds, startHeroStills } from "./home.ts";
import { agentCommands, agentsGuideUrl, HERO_STILLS, heroLive, heroStills, huntState, newsTiles, WORLD_STILL, worldCards } from "./homeModel.ts";

const online: HomeOnline = {
  total: 5,
  bodies: {
    portus: { players: 2, names: ["Ashfall", "Wren_07"] },
    arcadia: { players: 3, names: ["Mossback"] },
    hollowmere: { players: 0, names: [] },
    meridian: { players: 0, names: [] },
    lumen: { players: 0, names: [] },
  },
};

describe("the hero's model", () => {
  it("cycles stills the build has, the hub first (the one index.html paints with the page)", () => {
    const ids = STILLS.map((s) => s.id);
    for (const id of HERO_STILLS) expect(ids, id).toContain(id);
    for (const id of Object.values(WORLD_STILL)) expect(ids, id).toContain(id);
    expect(heroStills(STILLS).map((s) => s.id)).toEqual([...HERO_STILLS]);
    expect(heroStills(STILLS, ["nope", "arcadia-lake"]).map((s) => s.id)).toEqual(["arcadia-lake"]);
    const html = readFileSync(join(process.cwd(), "apps/client/index.html"), "utf8"); // Vitest runs from the repo root
    expect(html).toContain(`src="/src/ui/stills/${HERO_STILLS[0]}.webp"`);
    // One still per world on its card, each of that world.
    for (const [body, id] of Object.entries(WORLD_STILL)) expect(STILLS.find((s) => s.id === id)!.body).toBe(body);
  });

  it("says who is online under Play, or invites the first one in", () => {
    expect(heroLive(online)).toBe("5 players online right now");
    expect(heroLive({ ...online, total: 1 })).toBe("1 player online right now");
    expect(heroLive({ ...online, total: 0 })).toBe("Be the first one online");
    expect(heroLive(null)).toBeNull();
  });

  it("every world has a short line apart from its blurb", () => {
    for (const w of worldCards(null)) {
      expect(w.line.length, w.id).toBeGreaterThan(10);
      expect(w.blurb.startsWith(w.line), w.id).toBe(false);
    }
  });

  it("reads the hunt's public state from the Hall of Firsts", () => {
    expect(huntState(null)).toBeNull();
    expect(huntState([])).toEqual({ text: "The vault has never been opened. Be the first.", claimed: false });
    expect(huntState([{ id: GLEAMS.firsts, name: "Mossback", foundAt: Date.UTC(2026, 10, 12) }])).toEqual({ text: "First opened by Mossback · Nov 12", claimed: true });
  });

  it("writes the three news tiles from the shared content", () => {
    const tiles = newsTiles([]);
    expect(tiles.map((t) => t.id)).toEqual(["spells", "hunt", "starters"]);
    expect(tiles[0]!.icons.map((i) => i.label)).toEqual(SPELLS.map((s) => s.keycap));
    expect(tiles[0]!.text).toContain("levels 1, 3, 6 and 9");
    expect(tiles[1]!.title).toBe("The hunt: The Three Gleams");
    expect(tiles[1]!.text).toContain("a ring race on Arcadia, a beacon to hold on Hollowmere, shards to gather on Meridian");
    expect(tiles[1]!.state).toContain("never been opened");
    expect(tiles[2]!.icons).toHaveLength(STARTERS.length);
    expect(newsTiles(null)[1]!.state).toBeNull(); // no board: the tile says nothing it doesn't know
  });

  it("brings an agent in with one command: Claude Code, Codex, or three curl lines", () => {
    const cmds = agentCommands("https://api.example.dev/");
    expect(cmds.map((c) => c.id)).toEqual(["claude", "codex", "curl"]);
    expect(cmds[0]!.text).toBe("claude mcp add --transport http firstlight https://api.example.dev/mcp");
    expect(cmds[1]!.text).toBe("codex mcp add firstlight --url https://api.example.dev/mcp");
    const curl = cmds[2]!.text.split("\n");
    expect(curl).toHaveLength(3);
    expect(curl[0]).toContain("https://api.example.dev/api/agent/join");
    expect(curl[2]).toContain('Authorization: Bearer $SEAT');
    const box = document.createElement("div");
    renderAgentCommands(box, "https://api.example.dev");
    expect([...box.querySelectorAll("[data-cmd]")].map((r) => (r as HTMLElement).dataset.cmd)).toEqual(["claude", "codex", "curl"]);
    expect(box.querySelectorAll("button").length).toBe(3);
    expect(box.querySelector("code")!.textContent).toContain("/mcp");
  });

  it("says plainly when the server has agents off", async () => {
    const note = document.createElement("p");
    note.hidden = true;
    const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    await paintAgentsSwitch(note, "https://api.example.dev", answer({ ok: true, enabled: false }));
    expect(note.hidden).toBe(false);
    await paintAgentsSwitch(note, "https://api.example.dev", answer({ ok: true, enabled: true }));
    expect(note.hidden).toBe(true);
    await paintAgentsSwitch(note, "https://api.example.dev", (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    expect(note.hidden).toBe(true);
  });

  it("links the agents guide by its path in the repo", () => {
    expect(agentsGuideUrl("https://github.com/o/r")).toBe("https://github.com/o/r/blob/main/docs/agents/playing.md");
    expect(agentsGuideUrl("https://github.com/o/r/")).toBe("https://github.com/o/r/blob/main/docs/agents/playing.md");
  });
});

describe("the hero's cross-fade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => (fn(0), 0));
    document.body.innerHTML = `<div id="box"><img class="is-on" src="first.webp" alt=""></div><div id="cap"></div>`;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const box = () => document.getElementById("box")!;
  const stills = [
    { id: "a", body: "portus" as const, caption: "Portus, the castle town", src: "first.webp" },
    { id: "b", body: "arcadia" as const, caption: "Glasswater Lake, Arcadia", src: "b.webp", focus: "40% 50%" },
    { id: "c", body: "meridian" as const, caption: "Cinder Canyons, Meridian", src: "c.webp" },
  ];

  it("names the still on screen, loads the next only when its turn comes, fades it in and removes the old one", async () => {
    const loaded: string[] = [];
    const stop = startHeroStills(box(), stills, { holdMs: 1000, fadeMs: 100, caption: document.getElementById("cap"), load: async (src) => (loaded.push(src), true) });
    expect(document.getElementById("cap")!.textContent).toBe("Portus, the castle town · in-game");
    expect(loaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loaded).toEqual(["b.webp"]);
    const imgs = [...box().querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["first.webp", "b.webp"]);
    expect(imgs.map((i) => i.classList.contains("is-on"))).toEqual([false, true]);
    expect(imgs[1]!.style.objectPosition).toBe("40% 50%");
    expect(imgs[1]!.alt).toBe("");
    expect(document.getElementById("cap")!.textContent).toBe("Glasswater Lake, Arcadia · in-game");
    await vi.advanceTimersByTimeAsync(250);
    expect(box().querySelectorAll("img").length).toBe(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(loaded).toEqual(["b.webp", "c.webp"]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(loaded).toHaveLength(2);
  });

  it("holds the first still under reduced motion, waits while the page is away, and skips a still that fails", async () => {
    const loaded: string[] = [];
    startHeroStills(box(), stills, { holdMs: 1000, still: true, load: async (src) => (loaded.push(src), true) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(loaded).toEqual([]);
    expect(box().querySelectorAll("img").length).toBe(1);

    let visible = false;
    const stop = startHeroStills(box(), stills, { holdMs: 1000, fadeMs: 100, visible: () => visible, load: async (src) => (loaded.push(src), src !== "b.webp") });
    await vi.advanceTimersByTimeAsync(4000);
    expect(loaded).toEqual([]); // under the loader or in a hidden tab: nothing downloads
    visible = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(loaded).toEqual(["b.webp"]);
    expect(box().querySelectorAll("img").length).toBe(1); // b failed: the first still stays
    await vi.advanceTimersByTimeAsync(300);
    expect(loaded).toEqual(["b.webp", "c.webp"]);
    expect(box().querySelector("img.is-on")!.getAttribute("src")).toBe("c.webp");
    stop();
  });

  it("parks with no timer while hidden when it can be woken, and resumes on show", async () => {
    const loaded: string[] = [];
    let visible = true;
    let wakeFn: (() => void) | null = null;
    let unsubscribed = false;
    const stop = startHeroStills(box(), stills, {
      holdMs: 1000, fadeMs: 100, visible: () => visible, load: async (src) => (loaded.push(src), true),
      wake: (fn) => ((wakeFn = fn), () => (unsubscribed = true)),
    });
    visible = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(loaded).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // nothing reschedules itself for the session
    wakeFn!(); // a wake while still hidden (tab back, landing still under the loader) stays parked
    expect(vi.getTimerCount()).toBe(0);
    visible = true;
    wakeFn!();
    wakeFn!(); // a second wake doesn't start a second clock
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(loaded).toEqual(["b.webp"]);
    stop();
    expect(unsubscribed).toBe(true);
  });
});

describe("the sections under the hero", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="home-live" hidden></div><span id="home-online-total"></span><ul id="home-online-list"></ul><div id="home-worlds"></div><div id="home-new"></div>`;
  });

  it("world cards carry a still, the line and who is there; a poll rewrites only the live row", () => {
    renderWorlds(null);
    const cards = [...document.querySelectorAll<HTMLElement>(".fl-home__world")];
    expect(cards.map((c) => c.dataset.world)).toEqual(["portus", "arcadia", "hollowmere", "meridian"]);
    const img = cards[1]!.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("arcadia-pond");
    expect(img.alt).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(cards[1]!.querySelector(".fl-home__wline")!.textContent).toBe("Golden meadows round Glasswater Lake");
    expect(cards[1]!.querySelector(".fl-home__wnow")!.textContent).toBe("– here");
    renderWorlds(online);
    expect(document.querySelectorAll(".fl-home__world").length).toBe(4);
    expect(cards[1]!.querySelector("img")).toBe(img); // the same element: no reload flicker
    expect(cards[1]!.querySelector(".fl-home__wnow")!.textContent).toBe("3 here: Mossback and 2 more");
    expect(cards[0]!.querySelector(".fl-home__wnow")!.textContent).toBe("2 here: Ashfall, Wren_07");
    expect(cards[2]!.querySelector(".fl-home__wnow")!.textContent).toBe("0 here right now");
    expect(cards[2]!.querySelector(".fl-home__wnow")!.classList.contains("is-empty")).toBe(true);
  });

  it("the hero's live line follows the online count", () => {
    renderOnline(online);
    const live = document.getElementById("home-live")!;
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe("5 players online right now");
    renderOnline(null);
    expect(live.hidden).toBe(true);
  });

  it("the hunt tile shows its public state once the board is known", () => {
    renderNews(null);
    expect(document.querySelectorAll(".fl-home__tile").length).toBe(3);
    expect(document.querySelector('[data-e2e="home-hunt-state"]')).toBeNull();
    renderNews({ levels: [], medals: [], hall: [{ id: GLEAMS.firsts, name: "Mossback", foundAt: Date.UTC(2026, 10, 12) }] });
    const st = document.querySelector<HTMLElement>('[data-e2e="home-hunt-state"]')!;
    expect(st.textContent).toBe("First opened by Mossback · Nov 12");
    expect(st.classList.contains("is-claimed")).toBe(true);
    expect(document.querySelectorAll(".fl-home__tile").length).toBe(3);
  });
});

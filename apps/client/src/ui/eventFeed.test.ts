import { describe, expect, it } from "vitest";
import { FEED_HUNT_MS, FEED_MAX, FEED_MS, FeedModel, feedPlain, feedText, Roster } from "./eventFeed.ts";

describe("the event feed's lines", () => {
  it("words each kind of news; an agent's name carries (AI) in plain text", () => {
    expect(feedPlain(feedText.joined({ name: "Wren_07" }))).toBe("Wren_07 arrived");
    expect(feedPlain(feedText.left({ name: "Tin_Lantern", agent: true }))).toBe("Tin_Lantern (AI) left");
    expect(feedPlain(feedText.fell({ name: "Pip" }, "Hopbit Bruiser"))).toBe("Pip fell to Hopbit Bruiser");
    expect(feedPlain(feedText.fell({ name: "Pip" }, null))).toBe("Pip fell");
    expect(feedPlain(feedText.fell({ name: "Pip" }, { name: "Vexa_77" }))).toBe("Vexa_77 felled Pip");
    expect(feedPlain(feedText.fell({ name: "Pip" }, { name: "Wren_07", me: true }))).toBe("You felled Pip");
    expect(feedPlain(feedText.felled("Hopbit", 12, 3))).toBe("Hopbit down · +12 XP · +3 ◎");
    expect(feedPlain(feedText.felled("Training wave", 0, 0))).toBe("Training wave down");
    expect(feedPlain(feedText.wonGleam({ name: "Mossback" }, "The Swift Gleam"))).toBe("Mossback won The Swift Gleam");
    expect(feedPlain(feedText.openedVault({ name: "Mossback" }))).toBe("Mossback opened the Gleam Vault");
  });
});

describe("the feed model", () => {
  it("keeps the newest lines, drops them when their time is up and says when it changed", () => {
    const f = new FeedModel();
    for (let i = 0; i < FEED_MAX + 2; i++) f.add("join", feedText.joined({ name: `p${i}` }), i * 2000);
    expect(f.lines).toHaveLength(FEED_MAX);
    expect(feedPlain(f.lines[0]!.parts)).toBe("p2 arrived");
    expect(f.tick(4000)).toBe(false);
    expect(f.tick(4000 + FEED_MS)).toBe(true); // p2 (added at 4000) goes
    expect(f.lines).toHaveLength(FEED_MAX - 1);
    expect(f.tick(60_000)).toBe(true);
    expect(f.lines).toHaveLength(0);
    expect(f.tick(60_001)).toBe(false);
  });

  it("hunt news stays longer", () => {
    const f = new FeedModel();
    f.add("hunt", feedText.wonGleam({ name: "a" }, "The Swift Gleam"), 0);
    f.add("join", feedText.joined({ name: "b" }), 0);
    f.tick(FEED_MS);
    expect(f.lines.map((l) => l.kind)).toEqual(["hunt"]);
    f.tick(FEED_HUNT_MS);
    expect(f.lines).toHaveLength(0);
  });

  it("the same line twice within a second is one line; later it is news again", () => {
    const f = new FeedModel();
    expect(f.add("kill", feedText.felled("Hopbit", 12, 3), 100)).not.toBeNull();
    expect(f.add("kill", feedText.felled("Hopbit", 12, 3), 600)).toBeNull();
    expect(f.add("kill", feedText.felled("Hopbit", 12, 3), 1200)).not.toBeNull();
    expect(f.lines).toHaveLength(2);
    expect(f.clear()).toBe(true);
    expect(f.clear()).toBe(false);
  });
});

describe("who is here", () => {
  const room = (...ids: string[]) => new Map(ids.map((id) => [id, { name: id }]));

  it("the first look is the people already there: nobody arrived", () => {
    const r = new Roster<{ name: string }>();
    expect(r.diff(room("a", "b"), "me")).toEqual({ joined: [], left: [] });
  });

  it("reports arrivals and departures between looks, never ourselves", () => {
    const r = new Roster<{ name: string }>();
    r.diff(room("a", "b", "me"), "me");
    expect(r.diff(room("a", "c", "me"), "me")).toEqual({ joined: [{ name: "c" }], left: [{ name: "b" }] });
    expect(r.diff(room("a", "c"), "me")).toEqual({ joined: [], left: [] });
    expect(r.diff(room(), "me")).toEqual({ joined: [], left: [{ name: "a" }, { name: "c" }] });
  });

  it("a new room starts silent again", () => {
    const r = new Roster<{ name: string }>();
    r.diff(room("a"), "me");
    r.reset();
    expect(r.diff(room("x", "y"), "me")).toEqual({ joined: [], left: [] });
  });
});

import { describe, expect, it } from "vitest";
import { feedKiller, FEED_HUNT_MS, FEED_MAX, FEED_MS, FeedModel, feedPlain, feedText, KillTally, Roster, TALLY_MS } from "./eventFeed.ts";

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

describe("kills in a row", () => {
  it("the same creature within a few seconds counts up with summed pay; another creature or a pause starts over", () => {
    const t = new KillTally();
    expect(t.add("Hopbit", 3, 3, 0)).toEqual({ count: 1, xp: 3, coins: 3, again: false });
    expect(t.add("Hopbit", 3, 3, 300)).toEqual({ count: 2, xp: 6, coins: 6, again: true });
    expect(t.add("Hopbit", 2, 3, 600)).toEqual({ count: 3, xp: 8, coins: 9, again: true });
    expect(feedPlain(feedText.felled("Hopbit", 8, 9, 3))).toBe("Hopbit ×3 down · +8 XP · +9 ◎");
    expect(t.add("Sparkfly", 5, 1, 700)).toEqual({ count: 1, xp: 5, coins: 1, again: false });
    expect(t.line).toBeNull();
    expect(t.add("Sparkfly", 5, 1, 700 + TALLY_MS + 1).again).toBe(false);
  });

  it("the feed rewrites the tally's line in place and gives it its time again", () => {
    const f = new FeedModel();
    const line = f.add("kill", feedText.felled("Hopbit", 3, 3), 0)!;
    f.add("join", feedText.joined({ name: "a" }), 100);
    expect(f.update(line.id, feedText.felled("Hopbit", 6, 6, 2), 3000)).toBe(true);
    expect(f.lines.map((l) => feedPlain(l.parts))).toEqual(["Hopbit ×2 down · +6 XP · +6 ◎", "a arrived"]);
    expect(f.lines[0]!.rev).toBe(1);
    f.tick(FEED_MS + 200); // the join line's time is up; the tally's was renewed at 3000
    expect(f.lines.map((l) => l.id)).toEqual([line.id]);
    f.tick(3000 + FEED_MS);
    expect(f.update(line.id, feedText.felled("Hopbit", 9, 9, 3), 20_000)).toBe(false);
  });
});

describe("who a death names as the killer", () => {
  it("reads a creature by its name, not its wire id; the world's causes as sent", () => {
    expect(feedKiller("npc:dusk_wolf")).toBe("Dusk Wolf");
    expect(feedPlain(feedText.fell({ name: "Pip" }, feedKiller("npc:dusk_wolf")))).toBe("Pip fell to Dusk Wolf");
    expect(feedKiller("the fall")).toBe("the fall");
    expect(feedKiller("")).toBeNull();
    expect(feedKiller(undefined)).toBeNull();
  });
});

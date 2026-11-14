// Residents you can talk to (#82) against the real server in-process: the `speak` rule (authored
// lines by id, agents only, slots checked), a person walking up to a resident and using the phrase
// wheel, and the budget switch that takes residents out while enough people are online.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirstlightAgent, type Heard } from "@firstlight/agent-kit";
import { CAST, runResidents } from "@firstlight/agent-tools/residents";
import { scriptedBrain } from "@firstlight/agent-tools/resident-talk";
import { LINE_BY_ID, RESIDENT_LINES, renderLine } from "@firstlight/shared/content/residentLines";
import type { Game } from "../src/app.ts";
import { agentsOnline, resetAgentSlots } from "../src/world/agents.ts";
import { liveRooms } from "../src/social/index.ts";
import { startServer, waitFor } from "./helpers.ts";

let game: Game;
let url: string;
const agents: FirstlightAgent[] = [];

beforeAll(async () => {
  game = await startServer();
  url = `http://127.0.0.1:${game.port}`;
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => {});
  resetAgentSlots();
});

afterAll(async () => {
  await game.close();
});

const actor = (name: string) => [...liveRooms].flatMap((r) => [...r.actors.values()]).find((a) => a.identity.name === name);

/** A player joined with the kit; `person` clears the AI flag on the server, so residents treat it as a person. */
async function player(name: string, person = false): Promise<{ agent: FirstlightAgent; heard: Heard[] }> {
  const agent = new FirstlightAgent();
  agents.push(agent);
  await agent.connect({ url, token: `dev:t_${name.toLowerCase()}:${name}`, body: "portus" });
  await waitFor(() => !!actor(name));
  if (person) {
    const a = actor(name)!;
    a.identity.agent = false;
    a.state.agent = false;
  }
  const heard: Heard[] = [];
  agent.onHeard((h) => heard.push(h));
  return { agent, heard };
}

describe("the lines", () => {
  it("are short, unique, and every slot renders only from the fixed lists", () => {
    expect(new Set(RESIDENT_LINES.map((l) => l.id)).size).toBe(RESIDENT_LINES.length);
    for (const l of RESIDENT_LINES) {
      const text = renderLine(l, { you: "Pip_Rowan", me: "Marlo_Thistle", place: "the portal to Arcadia", dist: 24, dir: "north-east" });
      expect(text, l.id).toBeTruthy();
      expect(text!.length, l.id).toBeLessThanOrEqual(140);
      expect(text).not.toMatch(/[{}]/);
    }
    const where = LINE_BY_ID.get("marlo.where.1")!;
    expect(renderLine(where, { place: "the portal to Arcadia", dist: 24, dir: "north-east" })).toBe("The portal to Arcadia? 24 metres north-east. Tell them Marlo sent you. They won't know who that is. Say it anyway.");
    expect(renderLine(where, { place: "my <script> house", dist: 24, dir: "north-east" })).toBeNull();
    expect(renderLine(where, { place: "the portal to Arcadia", dist: 2.5, dir: "north-east" })).toBeNull();
    expect(renderLine(where, { place: "the portal to Arcadia", dist: 24, dir: "up" })).toBeNull();
    expect(renderLine(LINE_BY_ID.get("brindle.greet.1")!, { you: "Pip_Rowan", me: "Brindle_Oake" })).toMatch(/^Pip Rowan\. Brindle Oake\./);
  });
});

describe("speak", () => {
  it("says an authored line to people near, agents only, with checked slots", async () => {
    const res = await player("TalkRes");
    const pal = await player("TalkPal", true);
    const id = actor("TalkPal")!.id;
    expect((await res.agent.speak("tamsin.greet.1", { to: id })).ok).toBe(true);
    await waitFor(() => pal.heard.some((h) => h.text));
    expect(pal.heard.find((h) => h.text)).toMatchObject({ name: "TalkRes", line: "tamsin.greet.1", toMe: true, text: "Oh, hello TalkPal! Stand still a moment, you're improving the view." });
    // Refusals: too soon after the last line, unknown lines, slots off the lists, people can't speak lines.
    const denied = (a: FirstlightAgent) => a.events.filter((e) => e.type === "denied").map((e) => e.text);
    await res.agent.speak("tamsin.doing.1");
    await waitFor(() => denied(res.agent).some((t) => t.includes("too fast")));
    await new Promise((ok) => setTimeout(ok, 2100));
    await res.agent.speak("no.such.line");
    await waitFor(() => denied(res.agent).some((t) => t.includes("unknown line")));
    await new Promise((ok) => setTimeout(ok, 50));
    await res.agent.speak("tamsin.where.1", { place: "a place I made up", dist: 10, dir: "east" });
    await waitFor(() => denied(res.agent).some((t) => t.includes("bad slots")));
    await pal.agent.speak("tamsin.greet.2");
    await waitFor(() => denied(pal.agent).some((t) => t.includes("agents only")));
    expect(pal.heard.filter((h) => h.text)).toHaveLength(1);
  }, 40_000);
});

describe("talking to a resident", () => {
  it("greets a person who walks up, says what it does, and answers Help! with the way and a tip", async () => {
    const lines: string[] = [];
    const run = runResidents({ url, count: 1, cast: CAST.filter((c) => c.name === "Marlo_Thistle"), bodies: ["portus"], cpu: 1, dev: true, brain: scriptedBrain(() => 0), log: (l) => lines.push(`${Date.now() % 100000} ${l}`) });
    const wait = (cond: () => boolean, ms: number, label: string) => waitFor(cond, ms).catch(() => {
      throw new Error(`timed out: ${label}\n${lines.join("\n")}\nheard: ${JSON.stringify(pal?.heard ?? [])}`);
    });
    let pal = undefined as Awaited<ReturnType<typeof player>> | undefined;
    try {
      await waitFor(() => !!actor("Marlo_Thistle"), 20_000);
      // He walks to the shop and idles there; walk up to him.
      const me = await player("PipRowan", true);
      pal = me;
      await wait(() => me.agent.observe({ peek: true }).players.some((p) => p.name === "Marlo_Thistle"), 10_000, 'me.agent.observe({ peek: true }).players.some((p) => p.name === "Marlo_Thistle")');
      const marlo = () => me.agent.observe({ peek: true }).players.find((p) => p.name === "Marlo_Thistle")!;
      await me.agent.moveTo(marlo().id, { within: 3, seconds: 30 });
      await wait(() => me.heard.filter((h) => h.toMe).length >= 2, 15_000, 'me.heard.filter((h) => h.toMe).length >= 2');
      const [greet, doing] = me.heard.filter((h) => h.toMe);
      expect(greet!.line).toMatch(/^marlo\.greet\./);
      expect(greet!.text).toContain("PipRowan");
      expect(doing!.line).toMatch(/^marlo\.doing\./);
      // Help!: where to go for a level 1 (the portal to Arcadia), then a tip for that level.
      await me.agent.phrase("Help!");
      lines.push(`${Date.now() % 100000} TEST help sent`);
      await wait(() => me.heard.filter((h) => h.toMe).length >= 4, 15_000, 'me.heard.filter((h) => h.toMe).length >= 4');
      const [where, tip] = me.heard.filter((h) => h.toMe).slice(2);
      expect(where!.line).toMatch(/^marlo\.where\./);
      expect(where!.text).toMatch(/^The portal to Arcadia\? \d+ metres/);
      expect(where!.text).toMatch(/\d+ metres (north|south|east|west)/);
      expect(LINE_BY_ID.get(tip!.line!)).toMatchObject({ voice: "marlo", topic: "tip", levels: [1, 3] });
      const r = await me.agent.phrase("Thanks");
      lines.push(`${Date.now() % 100000} TEST thanks sent`);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      await wait(() => me.heard.some((h) => h.line?.startsWith("marlo.thanks.")), 10_000, 'me.heard.some((h) => h.line?.startsWith("marlo.thanks."))');
      run.stop();
      const report = await run.done;
      expect(report.residents[0]!.lines, lines.join("\n")).toBeGreaterThanOrEqual(5);
      expect(report.brain.kind).toBe("scripted");
    } finally {
      run.stop();
      await run.done;
    }
  }, 120_000);
});

describe("the budget switch", () => {
  it("residents step out while more people than the limit are online, and come back after", async () => {
    let people = 0;
    const run = runResidents({ url, count: 1, cast: CAST.filter((c) => c.name === "Tamsin_Hollis"), bodies: ["portus"], cpu: 1, dev: true, maxHumans: 2, humans: async () => people, humansEveryMs: 200, log: () => {} });
    try {
      await waitFor(() => !!actor("Tamsin_Hollis"), 20_000);
      people = 3;
      await waitFor(() => !actor("Tamsin_Hollis") && run.report().parked, 60_000);
      expect(run.report()).toMatchObject({ humans: 3, parked: true });
      expect(agentsOnline()).toBe(0);
      people = 2;
      await waitFor(() => !!actor("Tamsin_Hollis"), 30_000);
      expect(run.report().parked).toBe(false);
    } finally {
      run.stop();
      await run.done;
    }
  }, 150_000);

  // Review 2026-11-13 (agent gateway, GPT-6.1 Sol) #5: residents joined before the first count, and
  // a count that failed kept the last permission for good.
  it("over the limit at start-up: nobody joins at all", async () => {
    const lines: string[] = [];
    const run = runResidents({ url, count: 1, cast: CAST.filter((c) => c.name === "Tamsin_Hollis"), bodies: ["portus"], cpu: 1, dev: true, maxHumans: 2, humans: async () => 3, humansEveryMs: 200, log: (l) => lines.push(l) });
    try {
      await waitFor(() => run.report().humans === 3, 10_000);
      await new Promise((ok) => setTimeout(ok, 1500));
      expect(run.report()).toMatchObject({ humans: 3, parked: true });
      expect(lines.filter((l) => l.includes("joined")), lines.join("\n")).toEqual([]);
      expect(actor("Tamsin_Hollis")).toBeUndefined();
      expect(run.report().residents[0]!.status).toBe("parked");
    } finally {
      run.stop();
      await run.done;
    }
  }, 60_000);

  it("while the count is unknown they stay out, and a count that fails later takes them out", async () => {
    const lines: string[] = [];
    let people: number | null = null; // null: the count fails
    let asked = 0;
    const humans = async () => {
      asked++;
      if (people === null) throw new Error("count unavailable");
      return people;
    };
    const run = runResidents({ url, count: 1, cast: CAST.filter((c) => c.name === "Tamsin_Hollis"), bodies: ["portus"], cpu: 1, dev: true, maxHumans: 2, humans, humansEveryMs: 200, log: (l) => lines.push(l) });
    try {
      await waitFor(() => asked >= 3, 15_000);
      expect(run.report()).toMatchObject({ humans: null, parked: true });
      expect(lines.filter((l) => l.includes("joined")), lines.join("\n")).toEqual([]);
      expect(actor("Tamsin_Hollis")).toBeUndefined();
      // A valid count under the limit: in they come.
      people = 1;
      await waitFor(() => !!actor("Tamsin_Hollis"), 30_000);
      expect(run.report()).toMatchObject({ humans: 1, parked: false });
      // The count fails again: unknown is not permission, so they step out.
      people = null;
      await waitFor(() => !actor("Tamsin_Hollis") && run.report().parked, 60_000);
      expect(run.report().humans).toBeNull();
      expect(agentsOnline()).toBe(0);
    } finally {
      run.stop();
      await run.done;
    }
  }, 150_000);
});

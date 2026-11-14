// The residents' talk brains without a game: the scripted choices, and the model brain against a
// local fake endpoint in both API shapes (OpenAI-compatible and Anthropic), its hard budget, its
// slow cadence and its fallback to the scripted brain. No real model is called.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_BY_ID } from "@firstlight/shared/content/residentLines";
import { brainFromEnv, modelBrain, modelPrompt, parseAnswer, placesFor, scriptedBrain, type TalkContext } from "./resident-talk.ts";

/** Just the parts of an observation the brains read. */
function obs(over: Record<string, unknown> = {}): TalkContext["obs"] {
  return {
    self: { body: "portus", level: 3, zone: "safe" },
    portals: [
      { id: "portal:arcadia", to: "arcadia", dist: 19.4, bearing: 60 },
      { id: "portal:hollowmere", to: "hollowmere", dist: 16, bearing: 306 },
      { id: "portal:meridian", to: "meridian", dist: 16, bearing: 174 },
    ],
    guide: null,
    shops: [{ name: "Portus Exchange", dist: 12, bearing: 8, inReach: false }],
    hunt: { curator: { dist: 9, bearing: 267 } },
    players: [],
    ...over,
  } as unknown as TalkContext["obs"];
}
const person = (level = 1) => ({ id: "s1", name: "Pip_Rowan", level, dist: 3, bearing: 0, agent: false, dead: false });
const ctx = (trigger: TalkContext["trigger"], level = 1, o = obs()): TalkContext => ({ voice: "marlo", me: "Marlo_Thistle", trigger, to: person(level), obs: o });

describe("the scripted brain", () => {
  it("greets and says what it does; Help! points the way for the person's level, then a tip that fits it", async () => {
    const b = scriptedBrain(() => 0);
    const hi = await b.answer(ctx({ kind: "near" }));
    expect(hi.map((s) => LINE_BY_ID.get(s.line)!.topic)).toEqual(["greet", "doing"]);
    const help = await b.answer(ctx({ kind: "phrase", phrase: "Help!" }, 2));
    expect(help[0]).toMatchObject({ place: "the portal to Arcadia", dist: 19, dir: "north-east" });
    expect(LINE_BY_ID.get(help[1]!.line)).toMatchObject({ topic: "tip", levels: [1, 3] });
    // A level 9 in Portus is sent to Hollowmere, with a tip for its level.
    const nine = await b.answer(ctx({ kind: "phrase", phrase: "Help!" }, 9));
    expect(nine[0]).toMatchObject({ place: "the portal to Hollowmere" });
    expect(LINE_BY_ID.get(nine[1]!.line)!.levels).toEqual([6, 12]);
    expect((await b.answer(ctx({ kind: "phrase", phrase: "GG" })))[0]!.line).toMatch(/^marlo\.gg\./);
    // It doesn't repeat itself when it has another line.
    const a1 = (await b.answer(ctx({ kind: "near" })))[0]!.line;
    const a2 = (await b.answer(ctx({ kind: "near" })))[0]!.line;
    expect(a1).not.toBe(a2);
  });

  it("on a planet: the guide for a newcomer, the way home for one who has outgrown it", () => {
    const planet = obs({ self: { body: "arcadia", level: 3, zone: "safe" }, portals: [{ id: "portal:portus", to: "portus", dist: 9, bearing: 0 }], guide: { name: "Lark", dist: 5, bearing: 97 }, hunt: null });
    expect(placesFor(planet, 2)[0]).toMatchObject({ place: "Lark", dist: 5, dir: "east" });
    expect(placesFor(planet, 10)[0]).toMatchObject({ place: "the portal home to Portus", dir: "north" });
  });
});

// ------------------------------------------------------------------------- a local fake model

let server: Server;
let base: string;
const seen: { path: string; headers: IncomingMessage["headers"]; body: any }[] = [];
let reply: (path: string, body: any) => { status: number; json: unknown } = () => ({ status: 500, json: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const r = reply(req.url ?? "", body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const openaiSays = (text: string) => ({ status: 200, json: { choices: [{ message: { content: text } }], usage: { prompt_tokens: 410, completion_tokens: 22 } } });

describe("the model brain", () => {
  it("OpenAI-compatible: sends the short prompt, takes the line ids it chose, counts tokens", async () => {
    reply = () => openaiSays('{"say": [{"id": "marlo.where.2", "place": "the portal to Arcadia"}, {"id": "marlo.tip.2"}]}');
    const b = modelBrain({ api: "openai", url: base, model: "cheap-1", key: "sk-test", callsPerHour: 10, tokensPerHour: 10_000, minGapMs: 0 });
    const says = await b.answer(ctx({ kind: "phrase", phrase: "Help!" }));
    expect(says).toEqual([{ line: "marlo.where.2", place: "the portal to Arcadia", dist: 19, dir: "north-east" }, { line: "marlo.tip.2" }]);
    const call = seen.at(-1)!;
    expect(call.path).toBe("/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-test");
    expect(call.body).toMatchObject({ model: "cheap-1", max_tokens: 80 });
    expect(call.body.messages[1].content).toContain('Pip_Rowan (a person, level 1, 3 m away) said "Help!"');
    expect(call.body.messages[1].content).toContain("marlo.tip.1 [tip]");
    expect(call.body.messages[1].content).not.toContain("brindle."); // only its own voice's lines
    expect(b.stats).toMatchObject({ calls: 1, tokensIn: 410, tokensOut: 22, fallbacks: 0 });
  });

  it("Anthropic: the messages shape and headers", async () => {
    reply = () => ({ status: 200, json: { content: [{ type: "text", text: 'Sure: {"say": ["marlo.thanks.1"]}' }], usage: { input_tokens: 300, output_tokens: 12 } } });
    const b = modelBrain({ api: "anthropic", url: base, model: "haiku-like", key: "k-test", callsPerHour: 10, tokensPerHour: 10_000, minGapMs: 0 });
    expect(await b.answer(ctx({ kind: "phrase", phrase: "Thanks" }))).toEqual([{ line: "marlo.thanks.1" }]);
    const call = seen.at(-1)!;
    expect(call.path).toBe("/v1/messages");
    expect(call.headers["x-api-key"]).toBe("k-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body.system).toContain("You never write your own words");
  });

  it("falls back to the scripted brain: a failed call, an answer that doesn't fit, the cadence, the hourly budget", async () => {
    const b = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 3, tokensPerHour: 1_000_000, minGapMs: 0 }, scriptedBrain(() => 0));
    reply = () => ({ status: 500, json: { error: "down" } });
    expect((await b.answer(ctx({ kind: "phrase", phrase: "GG" })))[0]!.line).toMatch(/^marlo\.gg\./);
    expect(b.stats.lastFallback).toBe("http 500");
    // Free text, or a line it wasn't offered, never gets through.
    reply = () => openaiSays("Hello there, traveller! Lovely day.");
    expect((await b.answer(ctx({ kind: "phrase", phrase: "GG" })))[0]!.line).toMatch(/^marlo\.gg\./);
    expect(b.stats.lastFallback).toBe("bad answer");
    reply = () => openaiSays('{"say": ["brindle.gg.1"]}');
    await b.answer(ctx({ kind: "phrase", phrase: "GG" }));
    expect(b.stats.lastFallback).toBe("bad answer");
    // Three calls this hour: the fourth isn't made.
    const before = seen.length;
    expect((await b.answer(ctx({ kind: "near" }))).length).toBe(2);
    expect(seen.length).toBe(before);
    expect(b.stats).toMatchObject({ calls: 3, lastFallback: "budget" });
    // The slow cadence.
    const slow = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: 1_000_000, minGapMs: 60_000 });
    reply = () => openaiSays('{"say": ["marlo.gg.1"]}');
    await slow.answer(ctx({ kind: "phrase", phrase: "GG" }));
    await slow.answer(ctx({ kind: "phrase", phrase: "GG" }));
    expect(slow.stats).toMatchObject({ calls: 1, lastFallback: "cadence" });
    // The token budget counts too.
    const tight = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: 400, minGapMs: 0 });
    await tight.answer(ctx({ kind: "phrase", phrase: "GG" }));
    await tight.answer(ctx({ kind: "phrase", phrase: "GG" }));
    expect(tight.stats).toMatchObject({ calls: 1, lastFallback: "budget" });
  });

  it("parses only offered ids and only listed places; the env picks the brain", () => {
    const p = modelPrompt(ctx({ kind: "phrase", phrase: "Help!" }));
    const places = placesFor(obs(), 1);
    expect(parseAnswer('```json\n{"say":[{"id":"marlo.where.1","place":"Atlantis"}]}\n```', p.candidates, places)).toEqual([{ line: "marlo.where.1", ...places[0]! }]);
    expect(parseAnswer('{"say":["marlo.gg.1"]}', p.candidates, places)).toEqual([]); // not offered for Help!
    expect(parseAnswer("not json", p.candidates, places)).toEqual([]);
    expect(brainFromEnv({}).kind).toBe("scripted");
    expect(brainFromEnv({ FL_RESIDENT_BRAIN: "model" }).kind).toBe("scripted"); // no endpoint named
    expect(brainFromEnv({ FL_RESIDENT_BRAIN: "model", FL_RESIDENT_URL: base, FL_RESIDENT_MODEL: "m" }).kind).toBe("model");
  });
});

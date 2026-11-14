// The residents' talk brains without a game: the scripted choices, and the model brain against a
// local fake endpoint in both API shapes (OpenAI-compatible and Anthropic), its hard budget, its
// slow cadence and its fallback to the scripted brain. No real model is called.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_BY_ID } from "@firstlight/shared/content/residentLines";
import { brainFromEnv, Floor, modelBrain, modelPrompt, parseAnswer, placesFor, scriptedBrain, tokenReserve, type TalkContext } from "./resident-talk.ts";

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
    // The token budget counts too: room for one call's allowance, then the 432 it really used plus
    // the next allowance don't fit.
    const tight = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: tokenReserve(modelPrompt(ctx({ kind: "phrase", phrase: "GG" }))) + 100, minGapMs: 0 });
    await tight.answer(ctx({ kind: "phrase", phrase: "GG" }));
    await tight.answer(ctx({ kind: "phrase", phrase: "GG" }));
    expect(tight.stats).toMatchObject({ calls: 1, lastFallback: "budget" });
  });

  // Review 2026-11-13 (agent gateway, GPT-6.1 Sol) #2: the budget was checked against what finished
  // calls had spent, so concurrent conversations all went out (budgets of one call and one token let
  // three calls and 1,296 tokens through).
  it("concurrent conversations can't overspend: a call and a token allowance are reserved before the fetch", async () => {
    reply = () => openaiSays('{"say": ["marlo.gg.1"]}');
    const gg = () => ctx({ kind: "phrase", phrase: "GG" });
    const at = (b: ReturnType<typeof modelBrain>) => Promise.all([b.answer(gg()), b.answer(gg()), b.answer(gg())]);
    // One call an hour: three at once make one request.
    let before = seen.length;
    const oneCall = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 1, tokensPerHour: 1_000_000, minGapMs: 0 }, scriptedBrain(() => 0));
    expect((await at(oneCall)).every((says) => says.length === 1)).toBe(true); // everyone still gets an answer
    expect(seen.length - before).toBe(1);
    expect(oneCall.stats).toMatchObject({ calls: 1, fallbacks: 2, lastFallback: "budget" });
    // One token an hour: no call fits at all.
    before = seen.length;
    const oneToken = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 1, tokensPerHour: 1, minGapMs: 0 });
    await at(oneToken);
    expect(seen.length - before).toBe(0);
    expect(oneToken.stats).toMatchObject({ calls: 0, tokensIn: 0, tokensOut: 0 });
    // Room for one allowance and a half: one of three concurrent calls goes out.
    before = seen.length;
    const half = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: Math.floor(tokenReserve(modelPrompt(gg())) * 1.5), minGapMs: 0 });
    await at(half);
    expect(seen.length - before).toBe(1);
  });

  // Review round two, finding 6: a timeout or a failed read released the output allowance, though
  // the provider may have produced (and billed) the answer. Only reported usage lowers a reservation.
  it("keeps the whole reservation when the call's real usage is unknown; reported usage settles it", async () => {
    const gg = () => ctx({ kind: "phrase", phrase: "GG" });
    const reserve = tokenReserve(modelPrompt(gg()));
    const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    const outcomes: Record<string, () => Promise<Response>> = {
      "http 500": async () => new Response("{}", { status: 500 }),
      "http 429": async () => new Response("{}", { status: 429 }),
      timeout: async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      network: async () => {
        throw new TypeError("fetch failed");
      },
      "unreadable body": async () => new Response("{not json", { status: 200 }),
      "no usage": async () => ok({ choices: [{ message: { content: '{"say": ["marlo.gg.1"]}' } }] }),
    };
    for (const [name, answer] of Object.entries(outcomes)) {
      let calls = 0;
      // Room for two reservations less one token: a second call fits only if the first released any of its own.
      const b = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: 2 * reserve - 1, minGapMs: 0, fetch: async () => (calls++, answer()) }, scriptedBrain(() => 0));
      await b.answer(gg());
      await b.answer(gg());
      expect(calls, name).toBe(1);
      expect(b.stats.lastFallback, name).toBe("budget");
    }
    // Both numbers reported: the call holds what it used, so the next one fits.
    let calls = 0;
    const settled = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: 2 * reserve - 1, minGapMs: 0, fetch: async () => (calls++, ok({ choices: [{ message: { content: '{"say": ["marlo.gg.1"]}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } })) });
    await settled.answer(gg());
    await settled.answer(gg());
    expect(calls).toBe(2);
    // Half a report settles half: the unreported part keeps its reservation.
    const partial = modelBrain({ api: "openai", url: base, model: "m", callsPerHour: 99, tokensPerHour: 1e6, minGapMs: 0, fetch: async () => ok({ choices: [{ message: { content: '{"say": ["marlo.gg.1"]}' } }], usage: { completion_tokens: 5 } }) });
    await partial.answer(gg());
    expect(partial.stats).toMatchObject({ tokensIn: reserve - 80, tokensOut: 5 });
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

// Same class as review 2026-11-13 #1: the floor kept a hold for every person a resident ever spoke to.
describe("the floor", () => {
  it("gives the nearest resident the floor, and forgets holds that ran out", () => {
    const f = new Floor();
    expect(f.take("p1", "A", 1000, 0)).toBe(true);
    expect(f.take("p1", "B", 1000, 10)).toBe(false);
    expect(f.take("p1", "B", 1000, 1001)).toBe(true);
    for (let i = 0; i < 1000; i++) f.take(`walker${i}`, "A", 1000, 2000 + i);
    f.take("late", "A", 1000, 10_000);
    expect(f.size).toBeLessThanOrEqual(66);
  });
});

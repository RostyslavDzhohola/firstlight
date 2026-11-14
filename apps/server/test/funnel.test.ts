// The first-session funnel (#85) and client error reports, with real accounts and game.db: visits the
// server issues, the page's ingest endpoints and their bounds, the account steps the server takes
// where it decides them, saving, test visits and agents kept apart, retention, and the /stats section.
// The ship-readiness review's probes (docs/reviews/2026-11-13-ship-readiness-gpt-6.1-sol.md) each
// have a test here: findings 1, 2, 3, 5 and 9.

import { afterEach, describe, expect, it } from "vitest";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { newCharacter } from "@firstlight/shared/content/character";
import { accountLinks } from "../src/auth/links.ts";
import { mountOps } from "../src/ops/admin.ts";
import { INGEST, ingestConfig } from "../src/ops/funnel.ts";
import {
  FUNNEL_LIMITS,
  MAX_VISIT_ROWS,
  accountSubject,
  clientErrorReport,
  flushFunnel,
  funnelKpis,
  funnelQueueState,
  funnelReport,
  funnelWindows,
  hasStep,
  recordStep,
  resetFunnelBudgets,
  rollupFunnel,
} from "../src/db/funnel.ts";
import { stmt } from "../src/db/game-db.ts";
import { characterRepo } from "../src/world/characters.ts";
import { Browser, ORIGIN, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { safeLeave, waitFor } from "./helpers.ts";
import { bot, harness, me, objAt, offPad, serverRoom, tpAndWait, until } from "./quest-helpers.ts";

const CLAIM_TOKEN = "Kq3vX9pLw2TzR8mN5bYc7HfJ1sDgA4eU6iOoVxWyZtQ=";
const TOOL_SECRET = "tool-secret-for-the-funnel-test-0123456789abcdefABCDEF";
let server: AuthServer | null = null;
const saved = { ingest: { ...INGEST }, limits: { ...FUNNEL_LIMITS }, tool: ingestConfig.loadtestSecret };

afterEach(async () => {
  Object.assign(INGEST, saved.ingest);
  Object.assign(FUNNEL_LIMITS, saved.limits);
  ingestConfig.loadtestSecret = saved.tool;
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  harness.game = null;
  await server?.close();
  server = null;
});

async function start() {
  server = await startAuthServer({
    adminClaimToken: CLAIM_TOKEN,
    extraRoutes: (app, a) => mountOps(app, { db: a.db, requireAdmin: a.requireAdmin, allowedOrigins: [ORIGIN] }),
  });
  harness.game = server.game;
  resetFunnelBudgets(server.accounts.db);
  return server;
}

let ipSeq = 0;
/** A fresh client address per call unless one is given (the per-address limits stay out of the way). */
const nextIp = () => `198.51.${100 + Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

/** What the page sends: a text/plain JSON body (no CORS preflight). */
function post(s: AuthServer, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${s.base}${path}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", "x-real-ip": nextIp(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

/** A visit the server issues (the page asks when it loads). */
async function visit(s: AuthServer, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<string> {
  const r = await post(s, "/api/visit", body, headers);
  expect(r.status).toBe(200);
  const j = (await r.json()) as { visit?: string };
  expect(typeof j.visit).toBe("string");
  return j.visit!;
}

const visitId = (token: string) => token.split(".")[1]!;

const rows = (s: AuthServer, subject: string) => {
  flushFunnel(s.accounts.db);
  return stmt(s.accounts.db, "SELECT step, value, detail, kind FROM funnel_step WHERE subject = ? ORDER BY step").all(subject) as { step: string; value: number | null; detail: string | null; kind: string }[];
};
const count = (s: AuthServer, sql: string) => {
  flushFunnel(s.accounts.db);
  return (stmt(s.accounts.db, sql).get() as { n: number }).n;
};

describe("visits the server issues (review #2)", () => {
  it("records each step of an issued visit once, keeps its numbers, ignores unknown steps", async () => {
    const s = await start();
    const token = await visit(s);
    const r = await post(s, "/api/funnel", {
      visit: token,
      steps: [{ step: "play" }, { step: "world", value: 12.5, detail: "webgpu/medium" }, { step: "bogus" }, { step: "tutorial:move", value: 0 }, { step: "tutorial:look", value: 1 }, { step: "tutorial:Bad Id" }],
    });
    expect(r.status).toBe(200);
    // Acknowledged: every step the page may forget (taken, or refused for good).
    expect(((await r.json()) as { done: string[] }).done.sort()).toEqual(["bogus", "play", "tutorial:Bad Id", "tutorial:look", "tutorial:move", "world"]);
    // A second report of a step never overwrites the first.
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "world", value: 99, detail: "webgl2/low" }] });
    const got = rows(s, `v:${visitId(token)}`);
    expect(got.map((x) => x.step)).toEqual(["page", "play", "tutorial:look", "tutorial:move", "world"]);
    expect(got.find((x) => x.step === "world")).toMatchObject({ value: 12.5, detail: "webgpu/medium", kind: "person" });
    const report = funnelReport(s.accounts.db);
    expect(report.visits).toMatchObject({ page: 1, play: 1, world: 1 });
    expect(report.tutorial.map((t) => t.step)).toEqual(["move", "look"]); // the client's order, not the alphabet
    expect(report.backend).toEqual({ webgpu: 1 });
  });

  it("steps for a visit the server didn't issue are refused: made-up ids, forged and expired tokens", async () => {
    const s = await start();
    const token = await visit(s);
    const forged = token.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA");
    for (const v of ["visitAAAA1111", forged, `v1.${"A".repeat(22)}.p.0.0.x`]) {
      const r = await post(s, "/api/funnel", { visit: v, steps: [{ step: "play" }, { step: "world", value: 3 }] });
      expect(r.status).toBe(401);
    }
    expect(count(s, "SELECT COUNT(*) AS n FROM funnel_step WHERE step != 'page'")).toBe(0);
  });

  it("made-up events can't lift gets-in: the headline needs the server to see the visit join a world", async () => {
    const s = await start();
    // The review's probe: worlds without Play presses, and Play + world claims that never joined.
    for (let i = 0; i < 3; i++) await post(s, "/api/funnel", { visit: await visit(s), steps: [{ step: "world", value: 1 }] });
    await post(s, "/api/funnel", { visit: await visit(s), steps: [{ step: "play" }, { step: "world", value: 1 }] });
    const kpis = funnelKpis(funnelReport(s.accounts.db));
    expect(kpis.find((k) => k.id === "gets_in")).toMatchObject({ num: 0, den: 1, value: 0, source: "server" });
    const page = kpis.find((k) => k.id === "gets_in_page")!;
    expect(page).toMatchObject({ num: 1, den: 1, source: "page" }); // only visits that pressed Play
    for (const k of kpis) if (k.unit === "share" && k.value !== null) expect(k.value).toBeLessThanOrEqual(1);
  });

  it("a visit that really joins: /api/play carries its token and the room records the join", async () => {
    const s = await start();
    const token = await visit(s);
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }, { step: "world", value: 8, detail: "webgl2/low" }] });
    await bot("joiner1", "arcadia", "", { visit: token });
    await until("visit join", () => hasStep(s.accounts.db, `v:${visitId(token)}`, "join"));
    const kpis = funnelKpis(funnelReport(s.accounts.db));
    expect(kpis.find((k) => k.id === "gets_in")).toMatchObject({ num: 1, den: 1, ok: true });
    expect(kpis.find((k) => k.id === "gets_in_s")).toMatchObject({ value: 8 });
  });

  it("a visit's kind is fixed when it is issued: a later header can't move it out of the people's figures", async () => {
    const s = await start();
    ingestConfig.loadtestSecret = TOOL_SECRET;
    const token = await visit(s);
    // The review's probe: any x-loadtest-secret value on a later post.
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }] }, { "x-loadtest-secret": "whatever" });
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "pick" }] }, { "x-loadtest-secret": TOOL_SECRET, "x-firstlight-agent": "1" });
    expect(new Set(rows(s, `v:${visitId(token)}`).map((r) => r.kind))).toEqual(new Set(["person"]));
    expect(funnelReport(s.accounts.db).visits).toMatchObject({ page: 1, play: 1, pick: 1 });
    // A renewed token keeps the visit and its kind.
    const again = await visit(s, { prev: token, auto: true });
    expect(visitId(again)).toBe(visitId(token));
    expect(again.split(".")[2]).toBe("p");
  });
});

describe("test and agent visits are counted apart (review #5)", () => {
  it("our tools' secret (the right one), an automated page and the agent header each make a visit apart", async () => {
    const s = await start();
    ingestConfig.loadtestSecret = TOOL_SECRET;
    const person = await visit(s);
    const wrongSecret = await visit(s, {}, { "x-loadtest-secret": "whatever" }); // a guess is no test visit
    const tool = await visit(s, {}, { "x-loadtest-secret": TOOL_SECRET });
    const automated = await visit(s, { auto: true }); // navigator.webdriver, ?e2e, ?bench
    const agent = await visit(s, {}, { "x-firstlight-agent": "1" });
    for (const t of [person, wrongSecret, tool, automated, agent]) await post(s, "/api/funnel", { visit: t, steps: [{ step: "play" }] });
    const report = funnelReport(s.accounts.db);
    expect(report.visits).toEqual({ page: 2, play: 2 });
    expect(report.apart).toEqual({ test: 2, agent: 1 });
  });

  it("a visit issued as a person's that joins as an AI agent leaves the people's figures", async () => {
    const s = await start();
    const token = await visit(s);
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }] });
    // The join row takes the stricter of the visit's kind and the player's.
    await bot("agentjoin", "arcadia", "", { visit: token, agent: true });
    await until("visit join", () => hasStep(s.accounts.db, `v:${visitId(token)}`, "join"));
    expect(rows(s, `v:${visitId(token)}`).find((r) => r.step === "join")!.kind).toBe("agent");
    expect(funnelReport(s.accounts.db).visits).toEqual({});
  });
});

describe("the ingest is bounded (review #1)", () => {
  it("a flood from one address: a few visits, each at most MAX_VISIT_ROWS rows, then refusals", async () => {
    const s = await start();
    const ip = { "x-real-ip": "203.0.113.50" };
    const steps = [{ step: "play" }, { step: "pick" }, { step: "world" }, ...Array.from({ length: 13 }, (_, i) => ({ step: `tutorial:t${i}`, value: i }))];
    let issued = 0;
    for (let i = 0; i < 60; i++) {
      const r = await post(s, "/api/visit", {}, ip);
      if (r.status !== 200) continue;
      const t = ((await r.json()) as { visit?: string }).visit;
      if (!t) continue;
      issued++;
      for (let k = 0; k < 4; k++) await post(s, "/api/funnel", { visit: t, steps: steps.map((x) => ({ ...x, step: k ? `${x.step}${k}` : x.step })) }, ip);
    }
    expect(issued).toBe(INGEST.visitsPerIp);
    const n = count(s, "SELECT COUNT(*) AS n FROM funnel_step");
    expect(n).toBeLessThanOrEqual(INGEST.visitsPerIp * MAX_VISIT_ROWS);
    const perVisit = stmt(s.accounts.db, "SELECT MAX(c) AS n FROM (SELECT COUNT(*) AS c FROM funnel_step GROUP BY subject)").get() as { n: number };
    expect(perVisit.n).toBeLessThanOrEqual(MAX_VISIT_ROWS);
  });

  it("a flood from many addresses stops at the day's caps: visits, rows and error reports", async () => {
    FUNNEL_LIMITS.visitsPerDay = 12;
    FUNNEL_LIMITS.visitRowsPerDay = 40;
    FUNNEL_LIMITS.errorsPerDay = 5;
    const s = await start();
    let off = 0;
    for (let i = 0; i < 30; i++) {
      const r = (await (await post(s, "/api/visit", {})).json()) as { visit?: string; off?: boolean };
      if (r.off) {
        off++;
        continue;
      }
      await post(s, "/api/funnel", { visit: r.visit, steps: [{ step: "play" }, { step: "pick" }, { step: "world" }, { step: "tutorial:a", value: 0 }, { step: "tutorial:b", value: 1 }] });
      await post(s, "/api/client-error", { visit: r.visit, message: `TypeError: boom ${i}`, stack: "" });
    }
    expect(off).toBe(18);
    expect(count(s, "SELECT COUNT(DISTINCT subject) AS n FROM funnel_step")).toBeLessThanOrEqual(12);
    expect(count(s, "SELECT COUNT(*) AS n FROM funnel_step")).toBeLessThanOrEqual(40);
    expect(count(s, "SELECT COUNT(*) AS n FROM client_error")).toBeLessThanOrEqual(5);
    // /stats says the day was capped.
    expect(funnelWindows(s.accounts.db).limits.today.visitRows).toEqual({ used: 40, cap: 40 });
  });

  it("the body limit holds for every content type, before the global JSON parser", async () => {
    const s = await start();
    const token = await visit(s);
    const big = JSON.stringify({ visit: token, steps: [{ step: "play" }], pad: "x".repeat(5000) });
    for (const path of ["/api/visit", "/api/funnel", "/api/client-error"]) {
      for (const type of ["application/json", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "application/octet-stream", "multipart/form-data; boundary=x"]) {
        const r = await fetch(`${s.base}${path}`, { method: "POST", headers: { "content-type": type, "x-real-ip": nextIp() }, body: big });
        expect(r.status, `${path} as ${type}`).toBe(413);
      }
    }
    expect(rows(s, `v:${visitId(token)}`).map((r) => r.step)).toEqual(["page"]);
    // A small application/json body is read too (not swallowed by the global parser).
    const ok = await fetch(`${s.base}/api/funnel`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": nextIp() }, body: JSON.stringify({ visit: token, steps: [{ step: "play" }] }) });
    expect(ok.status).toBe(200);
    expect(rows(s, `v:${visitId(token)}`).map((r) => r.step)).toEqual(["page", "play"]);
  });

  it("writes are queued and flushed together, off the request", async () => {
    FUNNEL_LIMITS.flushMs = 8000;
    const s = await start();
    flushFunnel(); // no flush timer left over from another test
    const token = await visit(s);
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }, { step: "pick" }] });
    const db = s.accounts.db;
    // Nothing written by the request itself: the queue holds it until the timer's flush.
    expect((stmt(db, "SELECT COUNT(*) AS n FROM funnel_step").get() as { n: number }).n).toBe(0);
    expect(funnelQueueState().pending).toBeGreaterThanOrEqual(3);
    await waitFor(() => (stmt(db, "SELECT COUNT(*) AS n FROM funnel_step").get() as { n: number }).n === 3, 15_000);
  });

  it("old cohort days are folded into daily aggregates and their raw rows deleted; all time still counts them", async () => {
    const s = await start();
    const db = s.accounts.db;
    const DAY = 86_400_000;
    const now = Date.now();
    const old = now - (FUNNEL_LIMITS.retentionDays + 3) * DAY;
    // Two old visits (one got in), one old new character that took a mission; and a recent visit.
    for (const [v, steps] of [["oldVisitA", ["page", "play", "join", "world"]], ["oldVisitB", ["page", "play"]]] as const) for (const st of steps) recordStep(db, { subject: `v:${v}`, step: st, at: old, value: st === "world" ? 10 : null }, old);
    for (const st of ["new", "join", "mission"]) recordStep(db, { subject: accountSubject("oldChar"), step: st, at: old + 1000 }, old);
    const token = await visit(s);
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }] });
    flushFunnel(db);
    expect(rollupFunnel(db, now)).toBe(1);
    expect((stmt(db, "SELECT COUNT(*) AS n FROM funnel_step WHERE at < ?").get(now - DAY) as { n: number }).n).toBe(0);
    expect((stmt(db, "SELECT COUNT(*) AS n FROM funnel_day").get() as { n: number }).n).toBeGreaterThan(0);
    const w = funnelWindows(db, now);
    expect(w.kpis.all.find((k) => k.id === "gets_in")).toMatchObject({ num: 1, den: 3 });
    expect(w.kpis.all.find((k) => k.id === "mission")).toMatchObject({ num: 1, den: 1 });
    expect(w.kpis.all.find((k) => k.id === "gets_in_s")).toMatchObject({ value: 10 });
    expect(w.kpis.week.find((k) => k.id === "gets_in")).toMatchObject({ num: 0, den: 1 });
    expect(rollupFunnel(db, now)).toBe(0); // nothing left to fold
  });
});

describe("client error reports (/api/client-error)", () => {
  it("stores a size-limited report under the visit, marks its crash step, and groups by kind", async () => {
    const s = await start();
    const token = await visit(s);
    const err = (line: number) => ({ visit: token, message: `TypeError: x is undefined at frame ${line} for someone@example.com`, stack: `TypeError: x\n    at tick (https://firstlight.test/assets/Game-abc.js:1:${line})\n${"y".repeat(3000)}`, build: "b123", tier: "medium", backend: "webgpu" });
    expect((await post(s, "/api/client-error", err(10))).status).toBe(204);
    await post(s, "/api/client-error", err(20)); // the same kind (numbers and positions differ)
    await post(s, "/api/client-error", { visit: token, message: "", stack: "" }); // nothing to store
    expect((await post(s, "/api/client-error", { message: "no visit", stack: "" })).status).toBe(401);
    flushFunnel(s.accounts.db);
    const rep = clientErrorReport(s.accounts.db);
    expect(rep.total).toBe(2);
    expect(rep.kinds).toHaveLength(1);
    expect(rep.kinds[0]).toMatchObject({ count: 2, build: "b123", where: "webgpu/medium: 2" });
    expect(rep.kinds[0]!.message).toContain("[email]");
    expect(rep.kinds[0]!.stack.length).toBeLessThanOrEqual(600);
    expect(rows(s, `v:${visitId(token)}`).map((r) => r.step)).toEqual(["crash", "page"]);
  });

  it("is rate-limited per address and per visit", async () => {
    INGEST.errorsPerIp = 1;
    const s = await start();
    const token = await visit(s);
    const ip = { "x-real-ip": "203.0.113.77" };
    await post(s, "/api/client-error", { visit: token, message: "one", stack: "" }, ip);
    expect((await post(s, "/api/client-error", { visit: token, message: "two", stack: "" }, ip)).status).toBe(429);
    INGEST.errorsPerIp = 100;
    INGEST.errorsPerVisit = 2;
    for (let i = 0; i < 5; i++) await post(s, "/api/client-error", { visit: token, message: `kind ${"abcde"[i]}`, stack: "" });
    flushFunnel(s.accounts.db);
    expect(clientErrorReport(s.accounts.db).total).toBe(2);
  });

  it("keeps no URL secrets, path tokens, encoded emails or rejected objects (review #3)", async () => {
    const s = await start();
    const token = await visit(s);
    const reports = [
      // A URL with a token in its path and in its query.
      { message: "Failed to fetch https://firstlight.test/reset-password/Zq81mK0pLx7vT3sYw9aBcD4e?token=sekret123abc&email=a%40b.io#frag", stack: "Error\n    at load (https://firstlight.test/assets/Game-abc.js?token=sekret123abc:1:2)\n    at https://firstlight.test/verify/Zq81mK0pLx7vT3sYw9aBcD4e:3:4" },
      // An encoded email.
      { message: "No account for player%40example.com (player%2Btag%40example.org)", stack: "" },
      // A rejection that is an object: what a careless page might send.
      { message: JSON.stringify({ user: { email: "who@example.com", token: "abcDEF1234567890ghijKLMN" } }), stack: "" },
    ];
    for (const r of reports) await post(s, "/api/client-error", { visit: token, ...r });
    flushFunnel(s.accounts.db);
    const kept = (stmt(s.accounts.db, "SELECT message, stack FROM client_error").all() as { message: string; stack: string }[]).map((r) => `${r.message}\n${r.stack}`).join("\n");
    expect(kept).toContain("https://firstlight.test");
    expect(kept).toContain("Game-abc.js:1:2");
    for (const leak of ["Zq81mK0pLx7vT3sYw9aBcD4e", "sekret123abc", "a%40b.io", "a@b.io", "#frag", "player", "example.com", "example.org", "who@", "abcDEF1234567890ghijKLMN"]) expect(kept, leak).not.toContain(leak);
  });
});

describe("the funnel's account steps", () => {
  it("creation, join, mission, kill and levels are recorded once each where the server decides them", async () => {
    const s = await start();
    const db = s.accounts.db;
    const def = [...MISSION_BY_ID.values()].find((m) => !m.giver && m.body === "arcadia")!;
    const u = accountSubject("funnel1");
    // A new character starts in Portus (the first join makes it), then travels on.
    await bot("funnel1", "portus", "admin");
    await until("new", () => hasStep(db, u, "new"));
    const b = await bot("funnel1", "arcadia", "admin");
    await until("join", () => hasStep(db, u, "join"));
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: def.id });
    await until("mission", () => hasStep(db, u, "mission"));
    // A kill (the NPC lane's admin spawn and hurt, as the killer), out of the safe zone.
    await tpAndWait(b, offPad("arcadia", 0, 70));
    b.send("admin", { cmd: "unprotect" });
    b.send("npc", { cmd: "spawn", kind: "hopbit", x: me(b).x, y: me(b).y, z: me(b).z, instant: true, req: 1 });
    await until("npc", () => b.count("npcInfo") > 0);
    b.send("npc", { cmd: "hurt", id: b.last("npcInfo").id, amount: 10_000, as: b.id });
    await until("kill", () => hasStep(db, u, "kill"));
    // Levels through the real XP path.
    const room = serverRoom(b);
    room.grantXp(room.playerById(b.id)!, 100_000);
    await until("level5", () => hasStep(db, u, "level5"));
    expect(rows(s, u).map((r) => r.step)).toEqual(["join", "kill", "level2", "level5", "mission", "new"]);
    const report = funnelReport(db);
    expect(report.accounts).toMatchObject({ new: 1, join: 1, mission: 1, kill: 1, level2: 1, level5: 1 });
    expect(funnelKpis(report).find((k) => k.id === "mission")).toMatchObject({ num: 1, den: 1 });
  });

  it("a returning character (one from before the funnel) is not a new character (review #9)", async () => {
    const s = await start();
    const db = s.accounts.db;
    // The review's probe: a character saved before this build joins; every join used to count it.
    characterRepo.current.ensure?.("veteran1");
    characterRepo.current.save("veteran1", { ...newCharacter(0, 0, Date.now() - 30 * 86_400_000, 0), level: 6 });
    await bot("veteran1", "portus", "admin");
    await bot("rookie1", "portus", "admin");
    await until("joins", () => hasStep(db, accountSubject("veteran1"), "join") && hasStep(db, accountSubject("rookie1"), "join"));
    expect(hasStep(db, accountSubject("veteran1"), "new")).toBe(false);
    expect(hasStep(db, accountSubject("rookie1"), "new")).toBe(true);
    const report = funnelReport(db);
    expect(report.accounts.join).toBe(1);
    expect(funnelKpis(report).find((k) => k.id === "tutorial")).toMatchObject({ den: 1 });
  });

  it("a guest who saves: its steps follow it to the account, which records the save; the first session's length is kept", async () => {
    const s = await start();
    const db = s.accounts.db;
    const off = s.accounts.links.on((e) => accountLinks.emit(e)); // the rooms' link events, as in production
    const guest = new Browser(s, "198.51.100.30");
    const token = await guest.playToken();
    const guestId = String(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub);
    const { joinWithToken } = await import("./auth-helpers.ts");
    const room = await joinWithToken(s, token, "portus");
    harness.rooms.push(room);
    await until("join", () => hasStep(db, accountSubject(guestId), "join"));
    const data = await guest.saveWithEmail("funnel-save@test.invalid");
    const accountId = data.user.id;
    await until("saved", () => hasStep(db, accountSubject(accountId), "saved"));
    expect(hasStep(db, accountSubject(accountId), "join")).toBe(true);
    expect(hasStep(db, accountSubject(accountId), "new")).toBe(true);
    expect(rows(s, accountSubject(guestId))).toEqual([]);
    await safeLeave(room);
    harness.rooms.length = 0;
    // The session ends after its grace period; graceful shutdown ends it at once.
    const { endAllSessions } = await import("../src/social/index.ts");
    endAllSessions();
    await until("first_session", () => hasStep(db, accountSubject(accountId), "first_session"));
    const first = rows(s, accountSubject(accountId)).find((r) => r.step === "first_session")!;
    expect(first.value).toBeGreaterThanOrEqual(0);
    off();
  });

  it("our test accounts' steps stay out of the people's funnel", async () => {
    const s = await start();
    await bot("tester1", "arcadia", "admin");
    await waitFor(() => hasStep(s.accounts.db, accountSubject("tester1"), "join"));
    stmt(s.accounts.db, "INSERT INTO test_account (user_id, source, marked_at) VALUES (?, 'tool', 0)").run("tester1");
    flushFunnel(s.accounts.db);
    const report = funnelReport(s.accounts.db);
    expect(report.accounts.join ?? 0).toBe(0);
    expect(report.apart.test).toBe(1);
  });
});

describe("/stats shows the funnel", () => {
  it("the KPI table, the step tables and the error list, and the same in JSON", async () => {
    const s = await start();
    const token = await visit(s);
    await post(s, "/api/funnel", { visit: token, steps: [{ step: "play" }, { step: "world", value: 8, detail: "webgl2/low" }, { step: "tutorial:move", value: 0 }] });
    await post(s, "/api/client-error", { visit: token, message: "ReferenceError: boom", stack: "    at x (https://firstlight.test/a.js:1:2)", build: "b1", tier: "low", backend: "webgl2" });
    const owner = new Browser(s, "198.51.100.1");
    await owner.playToken();
    await owner.saveWithEmail("funnel-owner@example.test"); // the admin claim needs a saved account (D26)
    expect((await owner.fetch("/admin/claim", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: CLAIM_TOKEN }).toString() })).status).toBeLessThan(400);
    const html = await (await owner.fetch("/stats")).text();
    for (const h of ["Launch KPIs (#85)", "Play presses that reach the world", "Play presses that show the world", "First visit, step by step", "New characters, step by step", "Tutorial: move", "ReferenceError: boom", "webgl2/low: 1"]) expect(html).toContain(h);
    const json = (await (await owner.fetch("/stats?format=json")).json()) as any;
    expect(json.funnel.kpis.all.find((k: { id: string }) => k.id === "gets_in_page")).toMatchObject({ value: 1 });
    expect(json.funnel.kpis.all.find((k: { id: string }) => k.id === "gets_in")).toMatchObject({ value: 0 });
    expect(json.funnel.errors.week.total).toBe(1);
    expect(json.funnel.limits.today.visits.cap).toBe(FUNNEL_LIMITS.visitsPerDay);
  });
});

describe("the funnel's cohorts", () => {
  it("an account that saved but never had a character made under the funnel is not a new character", async () => {
    const s = await start();
    recordStep(s.accounts.db, { subject: accountSubject("homeOnly"), step: "saved" });
    recordStep(s.accounts.db, { subject: accountSubject("player1"), step: "new" });
    recordStep(s.accounts.db, { subject: accountSubject("player1"), step: "join" });
    recordStep(s.accounts.db, { subject: accountSubject("player1"), step: "saved" });
    expect(funnelReport(s.accounts.db).accounts).toEqual({ new: 1, join: 1, saved: 1 });
  });
});

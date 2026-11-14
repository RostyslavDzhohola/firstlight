// The first-session funnel (#85) and client error reports, with real accounts and game.db: the page's
// ingest endpoints, the account steps the server takes where it decides them, saving, test visits
// and agents kept apart, and the /stats section.

import { afterEach, describe, expect, it } from "vitest";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { accountLinks } from "../src/auth/links.ts";
import { mountOps } from "../src/ops/admin.ts";
import { INGEST } from "../src/ops/funnel.ts";
import { funnelKpis, funnelReport, clientErrorReport, accountSubject, hasStep } from "../src/db/funnel.ts";
import { stmt } from "../src/db/game-db.ts";
import { Browser, ORIGIN, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { safeLeave, waitFor } from "./helpers.ts";
import { bot, harness, me, objAt, offPad, serverRoom, tpAndWait, until } from "./quest-helpers.ts";

const CLAIM_TOKEN = "Kq3vX9pLw2TzR8mN5bYc7HfJ1sDgA4eU6iOoVxWyZtQ=";
let server: AuthServer | null = null;
const saved = { ...INGEST };

afterEach(async () => {
  Object.assign(INGEST, saved);
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
  return server;
}

/** What the page sends: a text/plain JSON body (no CORS preflight). */
function post(s: AuthServer, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${s.base}${path}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", "x-real-ip": "198.51.100.9", ...headers }, body: JSON.stringify(body) });
}

const rows = (s: AuthServer, subject: string) =>
  stmt(s.accounts.db, "SELECT step, value, detail, kind FROM funnel_step WHERE subject = ? ORDER BY step").all(subject) as { step: string; value: number | null; detail: string | null; kind: string }[];

describe("the funnel's page steps (/api/funnel)", () => {
  it("records each step of a visit once, keeps its numbers, ignores unknown steps", async () => {
    const s = await start();
    const visit = "visitAAAA1111";
    const r = await post(s, "/api/funnel", {
      visit,
      steps: [{ step: "page" }, { step: "play" }, { step: "world", value: 12.5, detail: "webgpu/medium" }, { step: "bogus" }, { step: "tutorial:move", value: 0 }, { step: "tutorial:look", value: 1 }, { step: "tutorial:Bad Id" }],
    });
    expect(r.status).toBe(204);
    // A second report of a step never overwrites the first.
    await post(s, "/api/funnel", { visit, steps: [{ step: "world", value: 99, detail: "webgl2/low" }] });
    const got = rows(s, `v:${visit}`);
    expect(got.map((x) => x.step)).toEqual(["page", "play", "tutorial:look", "tutorial:move", "world"]);
    expect(got.find((x) => x.step === "world")).toMatchObject({ value: 12.5, detail: "webgpu/medium", kind: "person" });
    // Malformed bodies and ids are dropped without an error answer.
    expect((await post(s, "/api/funnel", { visit: "x", steps: [{ step: "page" }] })).status).toBe(204);
    expect((await fetch(`${s.base}/api/funnel`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{nope" })).status).toBe(204);
    const report = funnelReport(s.accounts.db);
    expect(report.visits).toMatchObject({ page: 1, play: 1, world: 1 });
    expect(report.tutorial.map((t) => t.step)).toEqual(["move", "look"]); // the client's order, not the alphabet
    expect(report.medianWorldS).toBe(12.5);
    expect(report.backend).toEqual({ webgpu: 1 });
    const kpi = funnelKpis(report).find((k) => k.id === "gets_in")!;
    expect(kpi).toMatchObject({ value: 1, num: 1, den: 1, ok: true });
  });

  it("counts our tools' visits and agents apart from people", async () => {
    const s = await start();
    await post(s, "/api/funnel", { visit: "personVisit01", steps: [{ step: "page" }, { step: "play" }] });
    await post(s, "/api/funnel", { visit: "toolVisit0001", steps: [{ step: "page" }, { step: "play" }, { step: "world", value: 3 }] }, { "x-loadtest-secret": "whatever" });
    await post(s, "/api/funnel", { visit: "agentVisit001", steps: [{ step: "page" }] }, { "x-firstlight-agent": "1" });
    const report = funnelReport(s.accounts.db);
    expect(report.visits).toEqual({ page: 1, play: 1 });
    expect(report.apart).toEqual({ test: 1, agent: 1 });
    expect(funnelKpis(report).find((k) => k.id === "gets_in")).toMatchObject({ value: 0, num: 0, den: 1, ok: false });
  });

  it("is rate-limited per address", async () => {
    INGEST.funnelPerIp = 2;
    const s = await start();
    for (const v of ["limitVisit001", "limitVisit002", "limitVisit003"]) await post(s, "/api/funnel", { visit: v, steps: [{ step: "page" }] });
    expect(funnelReport(s.accounts.db).visits.page).toBe(2);
    // Another address still gets in.
    await post(s, "/api/funnel", { visit: "limitVisit004", steps: [{ step: "page" }] }, { "x-real-ip": "198.51.100.10" });
    expect(funnelReport(s.accounts.db).visits.page).toBe(3);
  });
});

describe("client error reports (/api/client-error)", () => {
  it("stores a redacted, size-limited report, marks the visit's crash step, and groups by kind", async () => {
    const s = await start();
    const err = (line: number) => ({ visit: "crashVisit001", message: `TypeError: x is undefined at frame ${line} for someone@example.com`, stack: `TypeError: x\n    at tick (https://firstlight.test/assets/Game-abc.js:1:${line})\n${"y".repeat(3000)}`, build: "b123", tier: "medium", backend: "webgpu" });
    await post(s, "/api/client-error", err(10));
    await post(s, "/api/client-error", err(20)); // the same kind (numbers and positions differ)
    await post(s, "/api/client-error", { message: "", stack: "" }); // nothing to store
    const rep = clientErrorReport(s.accounts.db);
    expect(rep.total).toBe(2);
    expect(rep.kinds).toHaveLength(1);
    expect(rep.kinds[0]).toMatchObject({ count: 2, build: "b123", where: "webgpu/medium: 2" });
    expect(rep.kinds[0]!.message).toContain("[email]");
    expect(rep.kinds[0]!.stack.length).toBeLessThanOrEqual(600);
    expect(rows(s, "v:crashVisit001").map((r) => r.step)).toEqual(["crash"]);
  });

  it("is rate-limited per address", async () => {
    INGEST.errorsPerIp = 1;
    const s = await start();
    await post(s, "/api/client-error", { message: "one", stack: "" });
    await post(s, "/api/client-error", { message: "two", stack: "" });
    expect(clientErrorReport(s.accounts.db).total).toBe(1);
  });
});

describe("the funnel's account steps", () => {
  it("join, mission, kill and levels are recorded once each where the server decides them", async () => {
    const s = await start();
    const db = s.accounts.db;
    const def = [...MISSION_BY_ID.values()].find((m) => !m.giver && m.body === "arcadia")!;
    const b = await bot("funnel1", "arcadia", "admin");
    const u = accountSubject("funnel1");
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
    expect(rows(s, u).map((r) => r.step)).toEqual(["join", "kill", "level2", "level5", "mission"]);
    const report = funnelReport(db);
    expect(report.accounts).toMatchObject({ join: 1, mission: 1, kill: 1, level2: 1, level5: 1 });
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
    const report = funnelReport(s.accounts.db);
    expect(report.accounts.join ?? 0).toBe(0);
    expect(report.apart.test).toBe(1);
  });
});

describe("/stats shows the funnel", () => {
  it("the KPI table, the step tables and the error list, and the same in JSON", async () => {
    const s = await start();
    await post(s, "/api/funnel", { visit: "statsVisit001", steps: [{ step: "page" }, { step: "play" }, { step: "world", value: 8, detail: "webgl2/low" }, { step: "tutorial:move", value: 0 }] });
    await post(s, "/api/client-error", { visit: "statsVisit001", message: "ReferenceError: boom", stack: "at x (a.js:1:2)", build: "b1", tier: "low", backend: "webgl2" });
    const owner = new Browser(s, "198.51.100.1");
    await owner.playToken();
    await owner.saveWithEmail("funnel-owner@example.test"); // the admin claim needs a saved account (D26)
    expect((await owner.fetch("/admin/claim", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: CLAIM_TOKEN }).toString() })).status).toBeLessThan(400);
    const html = await (await owner.fetch("/stats")).text();
    for (const h of ["Launch KPIs (#85)", "Play presses that reach the world", "First visit, step by step", "New characters, step by step", "Tutorial: move", "ReferenceError: boom", "webgl2/low: 1"]) expect(html).toContain(h);
    const json = (await (await owner.fetch("/stats?format=json")).json()) as any;
    expect(json.funnel.kpis.all.find((k: { id: string }) => k.id === "gets_in")).toMatchObject({ value: 1 });
    expect(json.funnel.errors.week.total).toBe(1);
  });
});

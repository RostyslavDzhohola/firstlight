// Seam 1 with real accounts and game.db: bans (account + IP), blocks, reports, session analytics,
// and the /admin and /stats pages behind an admin session.

import { afterEach, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import { CLOSE } from "@firstlight/shared/net/social";
import { isBlockedEitherWay, listBans, listReports } from "../src/db/index.ts";
import { stmt } from "../src/db/game-db.ts";
import { accountLinks } from "../src/auth/links.ts";
import { mountOps } from "../src/ops/admin.ts";
import { banExplainer } from "../src/social/refusal.ts";
import { recordError } from "../src/ops/errors.ts";
import { ANALYTICS, blockedEitherWay, partyOf } from "../src/social/index.ts";
import { api, Browser, decodeJwt, ORIGIN, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { safeLeave, waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
const rooms: Room[] = [];

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await server?.close();
  server = null;
});

async function start(over: Parameters<typeof startAuthServer>[0] = {}) {
  server = await startAuthServer({
    adminClaimToken: "claim-token-for-tests",
    ...over,
    extraRoutes: (app, a) => mountOps(app, { db: a.db, requireAdmin: a.requireAdmin, allowedOrigins: [ORIGIN] }),
  });
  return server;
}

/** Enter the world with a token from a given client IP (x-real-ip, as Railway's edge sets it). */
async function enter(s: AuthServer, token: string, body = "arcadia", ip = "198.51.100.50", extra: Record<string, unknown> = {}): Promise<Room> {
  const r = await play(s, token, { body, ...extra }, { "x-real-ip": ip });
  if (!r.json.ok) throw new Error(`play refused: ${JSON.stringify(r.json)}`);
  const room = await new Client(s.base).consumeSeatReservation(r.json.reservation as never);
  room.onMessage("*", () => {});
  rooms.push(room);
  return room;
}

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);

function inbox<T = any>(r: Room, type: string): T[] {
  const list: T[] = [];
  r.onMessage(type, (m: T) => list.push(m));
  return list;
}

describe("bans with real accounts", () => {
  it("an admin ban disconnects the player and refuses rejoin by account and by network", async () => {
    const s = await start();
    const badIp = "203.0.113.66";
    const victimBrowser = new Browser(s, badIp);
    const victimToken = await victimBrowser.playToken();
    const victim = await enter(s, victimToken, "arcadia", badIp);
    // An alt account on the same network, and a bystander elsewhere.
    const alt = await enter(s, await new Browser(s, badIp).playToken(), "arcadia", badIp);
    const bystander = await enter(s, await new Browser(s, "198.51.100.2").playToken(), "arcadia", "198.51.100.2");
    const admin = await enter(s, "dev:mod1:Moderator:admin", "arcadia", "198.51.100.1");
    await waitFor(() => st(admin).players?.size === 4);
    let altCode = 0;
    alt.onLeave((c: number) => (altCode = c));
    let bystanderLeft = false;
    bystander.onLeave(() => (bystanderLeft = true));

    let code = 0;
    victim.onLeave((c: number) => (code = c));
    const kicked = inbox<any>(victim, "kicked");
    admin.send("mod", { action: "ban", target: victim.sessionId, reason: "aimbot" });
    await waitFor(() => code !== 0);
    expect(code).toBe(CLOSE.BANNED);
    expect(kicked[0]).toMatchObject({ code: CLOSE.BANNED });
    await waitFor(() => !st(admin).players.has(victim.sessionId));
    // The network ban removes the alt at once; the bystander stays.
    await waitFor(() => altCode === CLOSE.BANNED);
    expect(bystanderLeft).toBe(false);

    const victimId = String(decodeJwt(victimToken).sub);
    const ban = listBans(s.accounts.db).find((b) => b.userId === victimId)!;
    expect(ban).toMatchObject({ reason: "aimbot", createdBy: "mod1" });
    expect(ban.ipHash).toBe(s.accounts.hashIp(badIp));

    // Account: the same token is refused, from any address.
    expect((await play(s, victimToken, { body: "portus" }, { "x-real-ip": "198.51.100.77" })).status).toBe(401);
    // Network: a fresh guest from that address can't sign in, and no token gets in from it.
    const fresh = new Browser(s, badIp);
    expect((await fresh.client.signIn.anonymous()).error?.status).toBe(403);
    const otherToken = await new Browser(s, "198.51.100.78").playToken();
    expect((await play(s, otherToken, { body: "portus" }, { "x-real-ip": badIp })).status).toBe(401);
    expect((await play(s, otherToken, { body: "portus" }, { "x-real-ip": "198.51.100.78" })).json.ok).toBe(true);

    // In production /api/play then answers 403 "banned" (signed tokens only) so the client shows why.
    const explain = banExplainer(s.accounts);
    expect(await explain(victimToken, "198.51.100.77")).toBe("banned");
    expect(await explain(otherToken, badIp)).toBe("banned");
    expect(await explain(otherToken, "198.51.100.78")).toBeNull();
    expect(await explain("not-a-token", badIp)).toBeNull();
  });
});

describe("blocks and reports", () => {
  it("a block persists, is symmetric for voice, and stops party invites", async () => {
    const s = await start();
    const a = await enter(s, "dev:blk_a:Alpha", "portus");
    const b = await enter(s, "dev:blk_b:Bravo", "portus");
    await waitFor(() => st(a).players?.size === 2);
    const blocked = inbox<any>(a, "social:blocked");
    a.send("social:block", { target: b.sessionId });
    await waitFor(() => blocked.length > 0);
    expect(blocked[0].userIds).toEqual(["blk_b"]);
    expect(isBlockedEitherWay(s.accounts.db, "blk_b", "blk_a")).toBe(true);
    expect(blockedEitherWay("blk_a", "blk_b")).toBe(true);
    expect(blockedEitherWay("blk_b", "blk_a")).toBe(true);

    // Only real players can be blocked (no junk rows).
    const deniedA = inbox<any>(a, "denied");
    a.send("social:block", { target: "nobody-by-that-id" });
    await waitFor(() => deniedA.length > 0);
    expect(deniedA[0]).toEqual({ action: "block", reason: "player not found" });

    // Neither side can invite the other.
    const deniedB = inbox<any>(b, "denied");
    b.send("party", { action: "invite", target: a.sessionId });
    await waitFor(() => deniedB.length > 0);
    expect(deniedB[0].reason).toMatch(/can't invite/);

    // Survives a restart (game.db).
    for (const r of rooms.splice(0)) await safeLeave(r);
    const dir = s.dir;
    await s.close(true);
    const s2 = await start({ dir });
    const a2 = await enter(s2, "dev:blk_a:Alpha", "portus");
    const snapshot = inbox<any>(a2, "social:blocked");
    a2.send("client:info", { backend: "webgpu", tier: "medium" });
    await waitFor(() => snapshot.length > 0);
    expect(snapshot[0].userIds).toEqual(["blk_b"]);
    expect(blockedEitherWay("blk_b", "blk_a")).toBe(true);

    // Unblock.
    a2.send("social:block", { target: "blk_b", on: false });
    await waitFor(() => snapshot.length > 1);
    expect(snapshot[1].userIds).toEqual([]);
    expect(blockedEitherWay("blk_a", "blk_b")).toBe(false);
  });

  it("a report is stored with who, whom, where and when; repeats are throttled", async () => {
    const s = await start();
    const a = await enter(s, "dev:rep_a:Reporter", "arcadia");
    const b = await enter(s, "dev:rep_b:Griefer", "arcadia");
    await waitFor(() => st(a).players?.size === 2);
    const toasts = inbox<any>(a, "toast");
    const before = Date.now();
    a.send("report", { target: b.sessionId, reason: "harassment", note: "followed me  around\nshouting" });
    await waitFor(() => toasts.length > 0);
    a.send("report", { target: b.sessionId, reason: "cheating" });
    await waitFor(() => toasts.length > 1);
    const reports = listReports(s.accounts.db);
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r).toMatchObject({ reporter: "rep_a", target: "rep_b", body: "arcadia" });
    expect(r.reason).toBe("harassment [Griefer]: followed me around shouting");
    expect(r.createdAt).toBeGreaterThanOrEqual(before);
    const pb = st(a).players.get(b.sessionId);
    expect(Math.hypot(r.pos![0] - pb.x, r.pos![1] - pb.y, r.pos![2] - pb.z)).toBeLessThan(1);
  });
});

describe("parties and saving", () => {
  it("a guest who saves keeps their party under the new account id", async () => {
    const s = await start();
    // Production wires createAccounts to the process-wide bus; the test helper isolates it.
    const off = s.accounts.links.on((e) => accountLinks.emit(e));
    const guest = new Browser(s, "198.51.100.60");
    const guestToken = await guest.playToken();
    const guestId = String(decodeJwt(guestToken).sub);
    const a = await enter(s, guestToken, "portus", "198.51.100.60");
    const b = await enter(s, "dev:pal_b:Pal", "portus");
    await waitFor(() => st(a).players?.size === 2 && st(b).players?.size === 2);
    const invites = inbox<any>(b, "party:invite");
    a.send("party", { action: "invite", target: b.sessionId });
    await waitFor(() => invites.length > 0);
    b.send("party", { action: "accept", target: guestId });
    await waitFor(() => !!me(b)?.party && me(b).party === me(a)?.party);

    await guest.saveWithEmail("pal@example.test");
    const savedId = String(decodeJwt((await guest.client.token()).data!.token).sub);
    expect(savedId).not.toBe(guestId);
    expect(partyOf("pal_b").sort()).toEqual(["pal_b", savedId].sort());
    const states = inbox<any>(b, "party:state");
    await waitFor(() => states.some((x) => x.leader === savedId && x.members.some((m: any) => m.userId === savedId && m.online)));
    // The saved player can still manage the party.
    a.send("party", { action: "kick", target: "pal_b" });
    await waitFor(() => me(b).party === "");
    off();
  });
});

describe("session analytics", () => {
  it("a session row starts on join, spans travel, records backend/tier and ends after leaving; load-test players are skipped", async () => {
    ANALYTICS.END_GRACE_MS = 300;
    try {
      const s = await start({ loadtestSecret: "lt-secret" });
      const rows = (u: string) => stmt(s.accounts.db, "SELECT * FROM session_log WHERE user_id = ? ORDER BY id").all(u) as any[];

      const a = await enter(s, "dev:sess_a:Sessy", "portus");
      await waitFor(() => rows("sess_a").length === 1);
      expect(rows("sess_a")[0].ended_at).toBeNull();
      a.send("client:info", { backend: "WebGPU", tier: "high" });
      await waitFor(() => rows("sess_a")[0].backend === "webgpu");
      expect(rows("sess_a")[0].tier).toBe("high");

      // Travel within the grace period: still one session, time on both bodies.
      await new Promise((r) => setTimeout(r, 60));
      await safeLeave(a);
      const b = await enter(s, "dev:sess_a:Sessy:admin", "arcadia");
      await waitFor(() => !!me(b));
      // Level up, walk off the pad, die: the row records max level and deaths.
      const deaths = inbox<any>(b, "death");
      b.send("admin", { cmd: "level", args: { level: 5 } });
      const p = me(b);
      const len = Math.hypot(p.x, p.y, p.z);
      const up = [p.x / len, p.y / len, p.z / len];
      const side = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const k = side[0]! * up[0]! + side[1]! * up[1]! + side[2]! * up[2]!;
      const t = side.map((v, i) => v - k * up[i]!);
      const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
      b.send("admin", { cmd: "teleport", args: { x: p.x + (t[0]! / tl) * 40, y: p.y + (t[1]! / tl) * 40, z: p.z + (t[2]! / tl) * 40 } });
      b.send("admin", { cmd: "unprotect" });
      await waitFor(() => (me(b).flags & 1) === 0);
      b.send("admin", { cmd: "damage", args: { amount: 9999 } });
      await waitFor(() => deaths.length > 0);
      await safeLeave(b);
      rooms.splice(0);
      await waitFor(() => rows("sess_a")[0].ended_at !== null, 3000);
      const row = rows("sess_a");
      expect(row).toHaveLength(1);
      const bodyTime = JSON.parse(row[0].body_time_json);
      expect(Object.keys(bodyTime).sort()).toEqual(["arcadia", "portus"]);
      expect(row[0].deaths).toBe(1);
      expect(row[0].max_level).toBe(5);
      expect(row[0].ended_at).toBeGreaterThan(row[0].started_at);

      // Load-test bots never get a row.
      const bot = await enter(s, "dev:lt_bot1:Bot:loadtest", "arcadia", "198.51.100.9", { loadtest: true });
      await waitFor(() => st(bot).players?.size === 1);
      await new Promise((r) => setTimeout(r, 100));
      expect(rows("lt_bot1")).toHaveLength(0);
    } finally {
      ANALYTICS.END_GRACE_MS = 60_000;
    }
  });
});

describe("/admin and /stats", () => {
  it("need an admin session: 401 signed out, 403 for players, 200 for the admin", async () => {
    const s = await start();
    for (const path of ["/admin", "/stats"]) expect((await fetch(`${s.base}${path}`)).status).toBe(401);

    const player = new Browser(s, "198.51.100.30");
    const playerToken = await player.playToken();
    for (const path of ["/admin", "/stats"]) {
      expect((await player.fetch(path)).status).toBe(403);
      expect((await api(s, path, playerToken)).status).toBe(403);
    }

    const owner = new Browser(s, "198.51.100.31");
    await owner.playToken();
    expect((await owner.fetch("/admin/claim?token=claim-token-for-tests")).status).toBe(200);
    recordError("test", new Error("boom with a@b.example and Bearer abc.def"));
    const adminPage = await owner.fetch("/admin");
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get("content-type")).toContain("text/html");
    expect(adminPage.headers.get("cache-control")).toBe("no-store");
    const html = await adminPage.text();
    for (const h of ["Players online", "Reports", "Bans", "Recent server errors"]) expect(html).toContain(h);
    expect(html).toContain("boom with [email] and Bearer [redacted]");
    expect(html).not.toContain("<script");

    const statsPage = await owner.fetch("/stats");
    expect(statsPage.status).toBe(200);
    const stats = await statsPage.text();
    for (const h of ["online now", "sessions today", "Session length", "Renderer backend", "D1 return", "D7 return"]) expect(stats).toContain(h);
    const json = await (await owner.fetch("/stats?format=json")).json();
    expect(json).toMatchObject({ online: { total: 0 }, today: { sessions: expect.any(Number) }, retention: { cohorts: expect.any(Array) } });
  });

  it("admin forms: dismiss and ban from a report, lift a ban; cross-site posts are refused", async () => {
    const s = await start();
    const owner = new Browser(s, "198.51.100.41");
    await owner.playToken();
    await owner.fetch("/admin/claim?token=claim-token-for-tests");
    const a = await enter(s, "dev:frm_a:Ann", "portus");
    const b = await enter(s, "dev:frm_b:Bob", "portus");
    await waitFor(() => st(a).players?.size === 2);
    const toasts = inbox<any>(a, "toast");
    a.send("report", { target: b.sessionId, reason: "griefing" });
    await waitFor(() => toasts.length > 0);
    const [report] = listReports(s.accounts.db);

    const post = (path: string, body = "", origin: string | null = ORIGIN) =>
      owner.fetch(path, { method: "POST", body, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) } });

    // Browser.fetch always sets the client origin; a raw cross-site post without the session is refused anyway.
    const evil = await fetch(`${s.base}/admin/reports/${report!.id}/dismiss`, { method: "POST", headers: { origin: "https://evil.example", cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(evil.status).toBe(403);
    expect(listReports(s.accounts.db)).toHaveLength(1);

    let bobLeft = 0;
    b.onLeave((c: number) => (bobLeft = c));
    expect((await post(`/admin/reports/${report!.id}/ban`, "")).status).toBe(303); // no confirm: nothing happens
    expect(listBans(s.accounts.db)).toHaveLength(0);
    const res = await post(`/admin/reports/${report!.id}/ban`, "confirm=on");
    expect(res.status).toBe(303);
    await waitFor(() => bobLeft === CLOSE.BANNED);
    expect(listReports(s.accounts.db)).toHaveLength(0);
    const [ban] = listBans(s.accounts.db);
    expect(ban).toMatchObject({ userId: "frm_b" });
    expect((await play(s, "dev:frm_b:Bob", { body: "portus" })).json).toMatchObject({ ok: false, error: "banned" });

    expect((await post(`/admin/bans/${ban!.id}/lift`)).status).toBe(303);
    expect(listBans(s.accounts.db)).toHaveLength(0);
    expect((await play(s, "dev:frm_b:Bob", { body: "portus" })).json.ok).toBe(true);

    expect((await post("/admin/announce", "text=Server+restart+in+5+minutes")).status).toBe(303);
    const page = await (await owner.fetch("/admin?done=Announced")).text();
    expect(page).toContain("Announced");
  });
});

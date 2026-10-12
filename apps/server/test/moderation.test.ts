// Seam 1 with real accounts and game.db: bans (account + IP), blocks, reports, session analytics,
// and the /admin and /stats pages behind an admin session.

import { afterEach, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import { CLOSE } from "@firstlight/shared/net/social";
import { fileReport, isBlockedEitherWay, listBans, listReports } from "../src/db/index.ts";
import { stmt } from "../src/db/game-db.ts";
import { accountLinks } from "../src/auth/links.ts";
import { mountOps } from "../src/ops/admin.ts";
import { banExplainer } from "../src/social/refusal.ts";
import { recordError } from "../src/ops/errors.ts";
import { ANALYTICS, blockedEitherWay, partyOf, partyRoomFor, SOCIAL_RULES } from "../src/social/index.ts";
import { api, Browser, decodeJwt, ORIGIN, play, startAuthServer, ticketFor, type AuthServer } from "./auth-helpers.ts";
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
  ticketFor(token, body);
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

    // A pending invite the guest sent to a third player.
    const c = await enter(s, "dev:pal_c:Cee", "portus");
    await waitFor(() => st(a).players?.size === 3);
    const cInvites = inbox<any>(c, "party:invite");
    const cClosed = inbox<any>(c, "party:invite-closed");
    a.send("party", { action: "invite", target: c.sessionId });
    await waitFor(() => cInvites.length === 1);

    let closed = 0;
    a.onLeave((code) => (closed = code));
    const states = inbox<any>(b, "party:state");
    await guest.saveWithEmail("pal@example.test");
    const savedToken = (await guest.client.token()).data!.token;
    const savedId = String(decodeJwt(savedToken).sub);
    expect(savedId).not.toBe(guestId);
    expect(partyOf("pal_b").sort()).toEqual(["pal_b", savedId].sort());
    // The guest session is retired (4101, D26); the client rejoins as the saved account.
    await waitFor(() => closed === CLOSE.MERGED);
    const a2 = await enter(s, savedToken, "portus", "198.51.100.60");
    await waitFor(() => states.some((x) => x.leader === savedId && x.members.some((m: any) => m.userId === savedId && m.online)));
    // C's invite card is swapped for one from the saved account, and accepting it works.
    await waitFor(() => cClosed.some((x) => x.from === guestId && x.reason === "cancelled") && cInvites.length === 2);
    expect(cInvites[1].from).toBe(savedId);
    c.send("party", { action: "accept", target: savedId });
    await waitFor(() => !!me(c)?.party && me(c).party === me(b).party);
    // The saved player can still manage the party.
    a2.send("party", { action: "kick", target: "pal_b" });
    await waitFor(() => me(b).party === "");
    off();
  });

  /** A guest (real account) and a dev player in one party in Portus. */
  async function guestParty(s: AuthServer, ip: string, pal: string) {
    const guest = new Browser(s, ip);
    const guestToken = await guest.playToken();
    const guestId = String(decodeJwt(guestToken).sub);
    const a = await enter(s, guestToken, "portus", ip);
    const b = await enter(s, `dev:${pal}:Pal`, "portus");
    await waitFor(() => !!st(a).players?.get(b.sessionId) && !!st(b).players?.get(a.sessionId));
    const invites = inbox<any>(b, "party:invite");
    a.send("party", { action: "invite", target: b.sessionId });
    await waitFor(() => invites.length > 0);
    b.send("party", { action: "accept", target: guestId });
    await waitFor(() => !!me(b)?.party && me(b).party === me(a)?.party);
    return { guest, a, b };
  }

  it("a guest who saves and never rejoins leaves the party after the offline window, like anyone who drops", async () => {
    const s = await start();
    const off = s.accounts.links.on((e) => accountLinks.emit(e));
    const offlineMs = SOCIAL_RULES.PARTY_OFFLINE_MS;
    SOCIAL_RULES.PARTY_OFFLINE_MS = 1500;
    try {
      // Saving in the world: the guest session is retired (4101) and the client never rejoins.
      const p1 = await guestParty(s, "198.51.100.61", "pal_g");
      let closed = 0;
      p1.a.onLeave((code) => (closed = code));
      await p1.guest.saveWithEmail("ghost@example.test");
      const saved1 = String(decodeJwt((await p1.guest.client.token()).data!.token).sub);
      await waitFor(() => closed === CLOSE.MERGED);
      expect(partyOf("pal_g").sort()).toEqual(["pal_g", saved1].sort()); // kept for a quick rejoin...
      await waitFor(() => me(p1.b)?.party === ""); // ...but the saved player never came back
      expect(partyOf(saved1)).toEqual([saved1]);

      // Saving after leaving the world: the guest's offline timer must not be lost on the way.
      const p2 = await guestParty(s, "198.51.100.62", "pal_h");
      await p2.a.leave();
      await p2.guest.saveWithEmail("ghost2@example.test");
      const saved2 = String(decodeJwt((await p2.guest.client.token()).data!.token).sub);
      expect(partyOf("pal_h").sort()).toEqual(["pal_h", saved2].sort());
      await waitFor(() => me(p2.b)?.party === "");
      expect(partyOf(saved2)).toEqual([saved2]);
    } finally {
      SOCIAL_RULES.PARTY_OFFLINE_MS = offlineMs;
      off();
    }
  });
});

describe("account merges and blocks (F12 social review 1)", () => {
  /** A saved account (email) that is not in the world. */
  async function savedAccount(s: AuthServer, ip: string, email: string) {
    const b = new Browser(s, ip);
    await b.playToken();
    await b.saveWithEmail(email);
    const token = (await b.client.token()).data!.token;
    return { id: String(decodeJwt(token).sub), token };
  }

  /** A guest on a new browser who enters `body` and joins `leader`'s party. */
  async function guestInParty(s: AuthServer, ip: string, leader: Room) {
    const b = new Browser(s, ip);
    const token = await b.playToken();
    const id = String(decodeJwt(token).sub);
    const g = await enter(s, token, "portus", ip);
    await waitFor(() => st(leader).players?.has(g.sessionId));
    const invites = inbox<any>(g, "party:invite");
    leader.send("party", { action: "invite", target: g.sessionId });
    await waitFor(() => invites.length > 0);
    g.send("party", { action: "accept", target: invites[0].from });
    await waitFor(() => !!me(g)?.party && me(g).party === me(leader)?.party);
    return { b, id, room: g };
  }

  it("signing a guest into an account that blocked, or was blocked by, a party member splits the party before routing", async () => {
    const s = await start();
    const off = s.accounts.links.on((e) => accountLinks.emit(e));
    try {
      const bee = await enter(s, "dev:mrg_bee:Bee", "portus");
      // Outgoing: account A blocked Bee earlier.
      const a = await savedAccount(s, "198.51.100.80", "mrg-a@example.test");
      const aRoom = await enter(s, a.token, "portus", "198.51.100.80");
      await waitFor(() => st(bee).players?.has(aRoom.sessionId));
      aRoom.send("social:block", { target: bee.sessionId });
      await waitFor(() => blockedEitherWay(a.id, "mrg_bee"));
      await safeLeave(aRoom);
      const ga = await guestInParty(s, "198.51.100.81", bee);
      await ga.b.saveWithEmail("mrg-a@example.test");
      expect(partyOf(a.id)).toEqual([a.id]);
      expect(partyOf("mrg_bee")).toEqual(["mrg_bee"]);
      expect(partyRoomFor(a.id, "portus")).toBeUndefined();

      // Incoming: Bee blocked account C earlier.
      const c = await savedAccount(s, "198.51.100.82", "mrg-c@example.test");
      const cRoom = await enter(s, c.token, "portus", "198.51.100.82");
      await waitFor(() => st(bee).players?.has(cRoom.sessionId));
      bee.send("social:block", { target: cRoom.sessionId });
      await waitFor(() => blockedEitherWay("mrg_bee", c.id));
      await safeLeave(cRoom);
      const gc = await guestInParty(s, "198.51.100.83", bee);
      await gc.b.saveWithEmail("mrg-c@example.test");
      expect(partyOf(c.id)).toEqual([c.id]);
      expect(partyOf("mrg_bee")).toEqual(["mrg_bee"]);
      expect(partyRoomFor(c.id, "portus")).toBeUndefined();
    } finally {
      off();
    }
  });

  it("an account that keeps its own party loses the members its guest blocked", async () => {
    const s = await start();
    const off = s.accounts.links.on((e) => accountLinks.emit(e));
    try {
      // Account D leads a party with Cid.
      const d = await savedAccount(s, "198.51.100.84", "mrg-d@example.test");
      const dRoom = await enter(s, d.token, "portus", "198.51.100.84");
      const cid = await enter(s, "dev:mrg_cid:Cid", "portus");
      await waitFor(() => st(dRoom).players?.has(cid.sessionId));
      const invites = inbox<any>(cid, "party:invite");
      dRoom.send("party", { action: "invite", target: cid.sessionId });
      await waitFor(() => invites.length > 0);
      cid.send("party", { action: "accept", target: d.id });
      await waitFor(() => partyOf(d.id).length === 2);
      // On another browser D plays as a guest, blocks Cid, then signs in: the blocks merge into D.
      const gb = new Browser(s, "198.51.100.85");
      const gToken = await gb.playToken();
      const g = await enter(s, gToken, "portus", "198.51.100.85");
      await waitFor(() => st(g).players?.has(cid.sessionId));
      g.send("social:block", { target: cid.sessionId });
      await waitFor(() => blockedEitherWay(String(decodeJwt(gToken).sub), "mrg_cid"));
      await gb.saveWithEmail("mrg-d@example.test");
      expect(blockedEitherWay(d.id, "mrg_cid")).toBe(true);
      expect(partyOf(d.id)).toEqual([d.id]);
      expect(partyOf("mrg_cid")).toEqual(["mrg_cid"]);
      expect(partyRoomFor("mrg_cid", "portus")).toBeUndefined();
    } finally {
      off();
    }
  });
});

describe("report limits survive saving (F12 social review 4)", () => {
  it("a guest who used up their reports can't file more after saving", async () => {
    const s = await start();
    const off = s.accounts.links.on((e) => accountLinks.emit(e));
    try {
      const targets: Room[] = [];
      for (let i = 0; i < 6; i++) targets.push(await enter(s, `dev:rl_t${i}:Tee${i}`, "portus"));
      const gb = new Browser(s, "198.51.100.90");
      const gToken = await gb.playToken();
      const g = await enter(s, gToken, "portus", "198.51.100.90");
      await waitFor(() => st(g).players?.size === 7);
      const toasts = inbox<any>(g, "toast");
      for (let i = 0; i < 5; i++) g.send("report", { target: targets[i]!.sessionId, reason: "griefing" });
      await waitFor(() => toasts.filter((t) => /Report sent/.test(t.text)).length === 5);
      let closed = 0;
      g.onLeave((c) => (closed = c));
      await gb.saveWithEmail("rl-saver@example.test");
      await waitFor(() => closed === CLOSE.MERGED);
      const savedToken = (await gb.client.token()).data!.token;
      const a = await enter(s, savedToken, "portus", "198.51.100.90");
      await waitFor(() => st(a).players?.has(targets[5]!.sessionId));
      const after = inbox<any>(a, "toast");
      a.send("report", { target: targets[5]!.sessionId, reason: "griefing" });
      await waitFor(() => after.length > 0);
      expect(after[0].text).toBe("Report already sent. Thanks.");
      expect(listReports(s.accounts.db)).toHaveLength(5);
    } finally {
      off();
    }
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
    await owner.saveWithEmail("owner31@example.test"); // admin claim needs a saved account (D26)
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
    await owner.saveWithEmail("owner41@example.test");
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

  it("reports are paged, so a flood can't push older ones out of reach (F12 should-fix 15)", async () => {
    const s = await start();
    const owner = new Browser(s, "198.51.100.42");
    await owner.playToken();
    await owner.saveWithEmail("owner42@example.test");
    await owner.fetch("/admin/claim?token=claim-token-for-tests");
    const db = s.accounts.db;
    fileReport(db, { reporter: "real_rep", target: "real_bad", reason: "the real one", now: 1_000 });
    for (let i = 0; i < 120; i++) fileReport(db, { reporter: "flooder", target: `t${i}`, reason: `spam ${i}`, now: 2_000 + i });
    const first = await (await owner.fetch("/admin")).text();
    expect(first).toContain("<b>121</b><span>open reports");
    expect(first).toContain("spam 119");
    expect(first).not.toContain("the real one");
    expect(first).toContain('href="/admin?reports=2#reports"');
    const last = await (await owner.fetch("/admin?reports=3")).text();
    expect(last).toContain("the real one");
    expect(last).not.toContain("spam 119");
    expect(last).toContain('href="/admin?reports=2#reports"');
    // Out-of-range pages show the last one.
    expect(await (await owner.fetch("/admin?reports=99")).text()).toContain("the real one");
  });
});

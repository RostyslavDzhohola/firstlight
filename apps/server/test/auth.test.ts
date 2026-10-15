// Seam 1: accounts over HTTP + SDK against the real server (Better Auth, game.db, /api/play).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@colyseus/sdk";
import { awardMedal, discoverPad, getAccount, loadCharacter, saveCharacter, type CharacterData } from "../src/db/index.ts";
import { otpSendsToday } from "../src/db/otp-budget.ts";
import { DevOutbox, type SendResult } from "../src/auth/mailer.ts";
import { OTP_PER_ACCOUNT_PER_DAY, OTP_PUBLIC_PER_IP_PER_DAY, OTP_PUBLIC_SHARE } from "../src/auth/better-auth.ts";

import type { AccountLinkedEvent } from "../src/auth/links.ts";
import { api, Browser, decodeJwt, joinWithToken, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

/** Dev outbox with a switchable delay and failure (the helper reads codes from any DevOutbox). */
class ControlledOutbox extends DevOutbox {
  delayMs = 0;
  fail = false;
  attempts = 0;
  override async sendOtp(email: string, otp: string): Promise<SendResult> {
    this.attempts++;
    if (this.delayMs) await new Promise((ok) => setTimeout(ok, this.delayMs));
    if (this.fail) return { ok: false, error: "test_failure" };
    return super.sendOtp(email, otp);
  }
}

let server: AuthServer | null = null;
const rooms: Room[] = [];

afterEach(async () => {
  for (const r of rooms.splice(0)) await r.leave().catch(() => {});
  await server?.close();
  server = null;
});

function charData(level: number, extra: Partial<CharacterData> = {}): CharacterData {
  return {
    starter: "ember",
    palette: 2,
    level,
    xp: level * 100,
    coins: 40,
    hp: 100,
    body: "arcadia",
    copyHint: 0,
    x: 1,
    y: 2,
    z: 3,
    heading: 0.5,
    inventory: [{ id: "hexquill" }],
    missionState: { hunt: 2 },
    lifeStartedAt: 1000,
    protectedUntil: 0,
    ...extra,
  };
}

describe("guest play", () => {
  it("a guest signs in anonymously, gets a JWT and enters the world through /api/play", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    const claims = decodeJwt(token);
    expect(typeof claims.sub).toBe("string");
    expect(claims.guest).toBe(true);
    expect(String(claims.name)).toMatch(/^Wanderer-\d{4}$/);

    const room = await joinWithToken(server, token, "portus");
    rooms.push(room);
    await waitFor(() => (room.state as any).players?.size === 1);
    const me = (room.state as any).players.get(room.sessionId);
    expect(me.userId).toBe(claims.sub);
    expect(me.name).toBe(claims.name);
  });

  it("the JWT payload carries name and guest flag only — never the email", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    await b.playToken();
    await b.saveWithEmail("keeper@example.test", "Keeper");
    const t = await b.client.token();
    const claims = decodeJwt(t.data!.token);
    expect(JSON.stringify(claims)).not.toContain("example.test");
    expect(claims.email).toBeUndefined();
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "guest", "iat", "iss", "name", "sub"]);
    expect(claims.guest).toBe(false);
    expect(claims.name).toBe("Keeper");
  });

  it("garbage, foreign and tampered tokens are refused", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    expect((await play(server, "not-a-jwt")).status).toBe(401);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "someone-else" })).toString("base64url");
    expect((await play(server, `${h}.${forged}.${s}`)).status).toBe(401);
    // a token from another server (different signing key)
    const other = await startAuthServer();
    const foreign = await new Browser(other).playToken();
    await other.close();
    expect((await play(server, foreign)).status).toBe(401);
  });
});

describe("saving a guest (email OTP)", () => {
  it("moves the character, medals and pads to the new account id; the guest id no longer works", async () => {
    server = await startAuthServer();
    const events: AccountLinkedEvent[] = [];
    server.accounts.links.on((e) => events.push(e));
    const b = new Browser(server);
    const guestToken = await b.playToken();
    const guestId = String(decodeJwt(guestToken).sub);

    // The guest plays: account row via /api/play, a room session, then progress the rooms would save.
    const room = await joinWithToken(server, guestToken, "arcadia");
    rooms.push(room);
    server.accounts.sessions.register(guestId, room.roomId, room.sessionId);
    const db = server.accounts.db;
    expect(saveCharacter(db, guestId, charData(3))).toBe(true);
    awardMedal(db, guestId, "first-blood");
    discoverPad(db, guestId, "arcadia", "pad-north");
    expect((await api(server, "/api/account/name", guestToken, { body: { name: "Mira_7" } })).json).toEqual({ ok: true, name: "Mira_7" });

    await b.saveWithEmail("mira@example.test", "Mira_7");
    const savedToken = (await b.client.token()).data!.token;
    const claims = decodeJwt(savedToken);
    const savedId = String(claims.sub);
    expect(savedId).not.toBe(guestId);
    expect(claims.guest).toBe(false);
    expect(claims.name).toBe("Mira_7");

    const me = (await api(server, "/api/account/me", savedToken)).json;
    expect(me).toMatchObject({ ok: true, userId: savedId, displayName: "Mira_7", guest: false, character: { level: 3, starter: 0, palette: 2, body: "arcadia" }, medals: ["first-blood"], pads: [{ body: "arcadia", padId: "pad-north" }] });
    expect(loadCharacter(db, savedId)?.inventory).toEqual([{ id: "hexquill" }]);
    expect(loadCharacter(db, guestId)).toBeNull();
    expect(getAccount(db, guestId)).toBeNull();

    // The old guest token is dead (the guest user was deleted on save).
    expect((await play(server, guestToken)).status).toBe(401);
    expect((await play(server, savedToken)).json.ok).toBe(true);

    // Live room clients can be re-keyed.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromUserId: guestId, toUserId: savedId, name: "Mira_7", character: "guest", merged: false, displaced: null });
    expect(events[0]!.moved).toMatchObject({ userId: savedId, roomId: room.roomId, sessionId: room.sessionId });
    expect(server.accounts.sessions.get(savedId)?.sessionId).toBe(room.sessionId);
    expect(server.accounts.sessions.get(guestId)).toBeNull();

    // A late autosave under the old guest id writes nothing.
    expect(saveCharacter(db, guestId, charData(4))).toBe(false);
  });

  it("keeps the guest's generated name when it saves without picking one", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const guestName = String(decodeJwt(await b.playToken()).name);
    await b.saveWithEmail("quiet@example.test", guestName);
    const claims = decodeJwt((await b.client.token()).data!.token);
    expect(claims.name).toBe(guestName);
  });

  it("keeps the guest's name even if the client forgets to pass it", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const guestToken = await b.playToken();
    await api(server, "/api/account/name", guestToken, { body: { name: "Forgetful" } });
    await b.saveWithEmail("forgot@example.test");
    const token = (await b.client.token()).data!.token;
    expect(decodeJwt(token).name).toBe("Forgetful");
    expect((await api(server, "/api/account/me", token)).json.name).toBe("Forgetful");
  });

  it("a wrong code is refused and the player stays a guest", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const guestToken = await b.playToken();
    await b.sendCode("typo@example.test");
    const code = server.accounts.devOutbox!.lastCode("typo@example.test")!;
    const wrong = code === "000000" ? "111111" : "000000";
    const r = await b.signInWithCode("typo@example.test", wrong);
    expect(r.error).toBeTruthy();
    expect((await play(server, guestToken)).json.ok).toBe(true);
    expect(decodeJwt((await b.client.token()).data!.token).guest).toBe(true);
  });
});

describe("second browser", () => {
  it("signing in with the same email gets the same account and character", async () => {
    server = await startAuthServer();
    const a = new Browser(server, "198.51.100.1");
    const guestToken = await a.playToken();
    await play(server, guestToken);
    saveCharacter(server.accounts.db, String(decodeJwt(guestToken).sub), charData(5));
    await a.saveWithEmail("twin@example.test", "Twin");
    const idA = String(decodeJwt((await a.client.token()).data!.token).sub);

    const b = new Browser(server, "198.51.100.2");
    await b.saveWithEmail("twin@example.test");
    const tokenB = (await b.client.token()).data!.token;
    expect(decodeJwt(tokenB).sub).toBe(idA);
    const me = (await api(server, "/api/account/me", tokenB)).json;
    expect(me).toMatchObject({ userId: idA, name: "Twin", guest: false, character: { level: 5 } });
  });

  it("a guest session in the second browser merges into the account: higher-level character wins, medals union", async () => {
    server = await startAuthServer();
    const db = server.accounts.db;
    const events: AccountLinkedEvent[] = [];
    server.accounts.links.on((e) => events.push(e));

    const a = new Browser(server, "198.51.100.1");
    const ta = await a.playToken();
    await play(server, ta);
    saveCharacter(db, String(decodeJwt(ta).sub), charData(6));
    awardMedal(db, String(decodeJwt(ta).sub), "explorer");
    await a.saveWithEmail("merge@example.test", "Merger");
    const accountId = String(decodeJwt((await a.client.token()).data!.token).sub);
    server.accounts.sessions.register(accountId, "room-a", "sess-a");

    const b = new Browser(server, "198.51.100.2");
    const tb = await b.playToken();
    const guestB = String(decodeJwt(tb).sub);
    await play(server, tb);
    saveCharacter(db, guestB, charData(2));
    awardMedal(db, guestB, "first-blood");
    discoverPad(db, guestB, "meridian", "pad-west");
    server.accounts.sessions.register(guestB, "room-b", "sess-b");
    await b.saveWithEmail("merge@example.test");

    const tb2 = (await b.client.token()).data!.token;
    expect(decodeJwt(tb2).sub).toBe(accountId);
    const me = (await api(server, "/api/account/me", tb2)).json;
    expect(me.character.level).toBe(6);
    expect([...me.medals].sort()).toEqual(["explorer", "first-blood"]);
    expect(me.pads).toEqual([{ body: "meridian", padId: "pad-west" }]);
    expect(me.name).toBe("Merger");
    expect(events.at(-1)).toMatchObject({ fromUserId: guestB, toUserId: accountId, character: "account", merged: true });
    // One live session per character: the newest (browser B) stays, browser A's is displaced.
    expect(events.at(-1)!.displaced).toMatchObject({ roomId: "room-a", sessionId: "sess-a" });
    expect(server.accounts.sessions.get(accountId)).toMatchObject({ roomId: "room-b", sessionId: "sess-b" });
    expect((await play(server, tb)).status).toBe(401);
  });
});

describe("stale cookies (#11533)", () => {
  it("a browser holding a cookie for a deleted session still gets a fresh guest session", async () => {
    server = await startAuthServer();
    const a = new Browser(server);
    await a.playToken();
    // Browser B ends up with A's cookie; A then saves, which deletes the guest and its sessions.
    const b = new Browser(server);
    for (const [k, v] of a.cookies) b.cookies.set(k, v);
    await a.saveWithEmail("stale@example.test");

    const token = await b.playToken();
    const claims = decodeJwt(token);
    expect(claims.guest).toBe(true);
    expect((await play(server, token)).json.ok).toBe(true);
    // And B keeps working on the next visit (a real cookie was set).
    expect((await b.client.getSession()).data?.user.id).toBe(claims.sub);
  });
});

describe("bans", () => {
  it("a banned account is refused at /api/play", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    expect((await play(server, token)).json.ok).toBe(true);
    const { banUser, unbanUser } = await import("../src/db/index.ts");
    banUser(server.accounts.db, { userId: String(decodeJwt(token).sub), ipHash: null, reason: "test" });
    expect((await play(server, token)).status).toBe(401);
    expect((await api(server, "/api/account/me", token)).status).toBe(401);
    unbanUser(server.accounts.db, String(decodeJwt(token).sub));
    expect((await play(server, token)).json.ok).toBe(true);
  });

  it("an IP ban refuses /api/play from that address and guest sign-in through the proxy", async () => {
    server = await startAuthServer({ originSecret: "proxy-secret" });
    const { banUser } = await import("../src/db/index.ts");
    const bad = "203.0.113.9";
    banUser(server.accounts.db, { ipHash: server.accounts.hashIp(bad), until: Date.now() + 60_000, reason: "test" });

    const ok = new Browser(server, "198.51.100.3");
    const token = await ok.playToken();
    expect((await play(server, token, { body: "portus" }, { "x-real-ip": "198.51.100.3" })).json.ok).toBe(true);
    expect((await play(server, token, { body: "portus" }, { "x-real-ip": bad })).status).toBe(401);

    const banned = new Browser(server, bad);
    const r = await banned.client.signIn.anonymous();
    expect(r.error?.status).toBe(403);
    // A spoofed client-IP header is stripped; only the proxy-forwarded address counts.
    const res = await fetch(`${server.base}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { "x-origin-secret": "proxy-secret", "x-forwarded-for": "198.51.100.4", "x-firstlight-client-ip": bad, "content-type": "application/json", origin: "http://localhost:5173" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});

describe("display names", () => {
  it("are unique ignoring case, 3–16 chars of letters, digits and _, and filtered", async () => {
    server = await startAuthServer();
    const t1 = await new Browser(server).playToken();
    const t2 = await new Browser(server).playToken();
    expect((await api(server, "/api/account/name", t1, { body: { name: "Ann_1" } })).json).toEqual({ ok: true, name: "Ann_1" });
    const taken = await api(server, "/api/account/name", t2, { body: { name: "ann_1" } });
    expect(taken.status).toBe(409);
    expect(taken.json.error).toBe("taken");
    expect((await api(server, "/api/account/name", t2, { body: { name: "ab" } })).json.error).toBe("length");
    expect((await api(server, "/api/account/name", t2, { body: { name: "seventeen_chars_x" } })).json.error).toBe("length");
    expect((await api(server, "/api/account/name", t2, { body: { name: "bad name" } })).json.error).toBe("chars");
    expect((await api(server, "/api/account/name", t2, { body: { name: "n1gg3r_x" } })).json.error).toBe("filtered");
    expect((await api(server, "/api/account/name", t2, { body: { name: "xX_fag_Xx" } })).json.error).toBe("filtered");
    // the owner can re-set their own name with different case
    expect((await api(server, "/api/account/name", t1, { body: { name: "ANN_1" } })).json.ok).toBe(true);
    // and the name is what other players see
    const room = await joinWithToken(server, t1, "portus");
    rooms.push(room);
    await waitFor(() => (room.state as any).players?.size === 1);
    expect((room.state as any).players.get(room.sessionId).name).toBe("ANN_1");
  });

  it("requires a valid token", async () => {
    server = await startAuthServer();
    expect((await api(server, "/api/account/name", null, { body: { name: "Nobody" } })).status).toBe(401);
  });
});

describe("admin claim", () => {
  it("works once, while signed in, and the burnt state survives a restart", async () => {
    server = await startAuthServer({
      adminClaimToken: "claim-me-once",
      extraRoutes: (app, a) => app.get("/admin/ping", a.requireAdmin, (_req, res) => void res.json({ ok: true })),
    });
    const owner = new Browser(server);
    await owner.playToken();
    expect((await owner.fetch("/admin/claim?token=claim-me-once")).status).toBe(403); // guests can't claim
    await owner.saveWithEmail("owner@example.test");
    const ownerToken = (await owner.client.token()).data!.token;
    expect((await api(server, "/admin/ping", ownerToken)).status).toBe(403);

    expect((await api(server, "/admin/claim?token=claim-me-once", null)).status).toBe(401);
    expect((await owner.fetch("/admin/claim?token=wrong")).status).toBe(403);
    const claim = await owner.fetch("/admin/claim?token=claim-me-once");
    expect(claim.status).toBe(200);
    expect(await claim.text()).toContain("now an admin");

    expect((await api(server, "/admin/ping", ownerToken)).status).toBe(200);
    expect((await owner.fetch("/admin/ping")).status).toBe(200); // session cookie works too
    expect((await api(server, "/api/account/me", ownerToken)).json.admin).toBe(true);

    const other = new Browser(server);
    await other.playToken();
    await other.saveWithEmail("other@example.test");
    const otherToken = (await other.client.token()).data!.token;
    expect((await other.fetch("/admin/claim?token=claim-me-once")).status).toBe(410);
    expect((await api(server, "/admin/ping", otherToken)).status).toBe(403);
    expect((await api(server, "/admin/ping", null)).status).toBe(401);

    // restart on the same files: still burnt, admin kept
    const dir = server.dir;
    await server.close(true);
    server = await startAuthServer({ dir, adminClaimToken: "claim-me-once" });
    const third = new Browser(server);
    await third.playToken();
    expect((await third.fetch("/admin/claim?token=claim-me-once")).status).toBe(410);
    expect((await api(server, "/api/account/me", ownerToken)).json.admin).toBe(true);
  });

  it("an admin keeps admin after a fresh sign-in on another browser", async () => {
    server = await startAuthServer({ adminClaimToken: "tok" });
    const b = new Browser(server);
    await b.playToken();
    await b.saveWithEmail("owner@example.test");
    expect((await b.fetch("/admin/claim?token=tok")).status).toBe(200);
    const c = new Browser(server);
    await c.playToken();
    await c.saveWithEmail("owner@example.test");
    const t = (await c.client.token()).data!.token;
    expect((await api(server, "/api/account/me", t)).json).toMatchObject({ admin: true, guest: false });
  });
});

describe("OTP budget", () => {
  it("refuses the 4th code to one email within an hour with a clear message", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    await b.playToken();
    for (let i = 0; i < 3; i++) expect((await b.sendCode("busy@example.test")).error).toBeNull();
    const fourth = await b.sendCode("BUSY@example.test");
    expect(fourth.error?.status).toBe(429);
    expect(fourth.error?.message).toBe("Saving is busy, try again later");
    expect(fourth.error?.code).toBe("SAVING_BUSY");
    // other emails are unaffected
    expect((await b.sendCode("calm@example.test")).error).toBeNull();
    // the last delivered code still works (the refused request didn't rotate it)
    const code = server.accounts.devOutbox!.lastCode("busy@example.test")!;
    expect((await b.signInWithCode("busy@example.test", code)).error).toBeNull();
  });

  it("enforces the global daily budget", async () => {
    server = await startAuthServer({ otpDailyBudget: 2 });
    const b = new Browser(server);
    await b.playToken();
    expect((await b.sendCode("one@example.test")).error).toBeNull();
    expect((await b.sendCode("two@example.test")).error).toBeNull();
    const third = await b.sendCode("three@example.test");
    expect(third.error?.message).toBe("Saving is busy, try again later");
  });

  it("reports a failed send instead of pretending success, and a failure doesn't use the budget", async () => {
    let calls = 0;
    server = await startAuthServer({
      otpPerEmailPerHour: 1,
      mailer: { kind: "resend", async sendOtp() { calls++; return { ok: false, error: "daily_quota_exceeded" }; } },
    });
    const b = new Browser(server);
    await b.playToken();
    const r = await b.sendCode("fail@example.test");
    expect(r.error?.status).toBe(503);
    expect(r.error?.message).toBe("Saving is busy, try again later");
    // per-email budget of 1 is still available because the failure was released
    const again = await b.sendCode("fail@example.test");
    expect(again.error?.status).toBe(503);
    expect(calls).toBe(2);
  });

  it("only sign-in codes can be requested", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const r = await b.client.emailOtp.sendVerificationOtp({ email: "x@example.test", type: "forget-password" });
    expect(r.error?.status).toBe(400);
  });
});

describe("who can ask for a code (F12: the global OTP budget can't be drained)", () => {
  const ask = (b: Browser, email: string) => b.client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });

  it("a fresh guest, or a request without a session, gets no email for a new address and uses no budget", async () => {
    server = await startAuthServer();
    const out = server.accounts.devOutbox!;
    const fresh = new Browser(server, "198.51.100.60");
    await fresh.playToken();
    expect((await ask(fresh, "new1@example.test")).error).toBeNull(); // the same answer as a real send
    const none = new Browser(server, "198.51.100.61");
    expect((await ask(none, "new2@example.test")).error).toBeNull();
    expect(out.sent).toBe(0);
    expect(out.lastCode("new1@example.test")).toBeNull();
    expect(otpSendsToday(server.accounts.db)).toBe(0);
    // After the first level-up the same guest can save.
    await fresh.levelUp(2);
    expect((await ask(fresh, "new1@example.test")).error).toBeNull();
    expect(out.lastCode("new1@example.test")).toMatch(/^\d{6}$/);
    expect(otpSendsToday(server.accounts.db)).toBe(1);
  });

  it("a returning player gets a code for their saved email on any browser, with or without a guest session", async () => {
    server = await startAuthServer();
    const out = server.accounts.devOutbox!;
    const a = new Browser(server, "198.51.100.62");
    await a.playToken();
    await a.saveWithEmail("back@example.test");
    const landing = new Browser(server, "198.51.100.63"); // no session yet
    expect((await ask(landing, "Back@example.test")).error).toBeNull();
    const freshGuest = new Browser(server, "198.51.100.64");
    await freshGuest.playToken(); // level 1
    expect((await ask(freshGuest, "back@example.test")).error).toBeNull();
    await waitFor(() => out.sent === 3); // public requests are delivered in the background
    const code = out.lastCode("back@example.test")!;
    expect((await freshGuest.signInWithCode("back@example.test", code)).error).toBeNull();
  });

  /** The raw HTTP answer to a public (no-session) code request. */
  async function publicAsk(s: AuthServer, email: string) {
    const b = new Browser(s, "198.51.100.66");
    const t0 = performance.now();
    const res = await b.fetch("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, type: "sign-in" }) });
    return { status: res.status, body: await res.text(), type: res.headers.get("content-type"), ms: performance.now() - t0 };
  }

  it("public answers are the same for unknown, saved, budget-exhausted and undeliverable addresses (no enumeration)", async () => {
    const mailer = new ControlledOutbox();
    server = await startAuthServer({ mailer });
    const a = new Browser(server, "198.51.100.65");
    await a.playToken();
    await a.saveWithEmail("taken@example.test"); // a player who may save: not counted against public requests
    const b = new Browser(server, "198.51.100.67");
    await b.playToken();
    await b.saveWithEmail("broken@example.test");
    const unknown = await publicAsk(server, "nobody@example.test");
    expect(unknown).toMatchObject({ status: 200 });
    for (let i = 0; i < 4; i++) expect(await publicAsk(server, "taken@example.test")).toMatchObject({ status: unknown.status, body: unknown.body, type: unknown.type });
    await waitFor(() => mailer.sent === 5); // 3 more codes went out; the 4th public ask hit the public hourly cap silently
    mailer.fail = true;
    expect(await publicAsk(server, "broken@example.test")).toMatchObject({ status: unknown.status, body: unknown.body, type: unknown.type });
    await waitFor(() => mailer.attempts === 6);
    expect(mailer.lastCode("nobody@example.test")).toBeNull();
  });

  it("public requests don't wait for the mailer", async () => {
    const mailer = new ControlledOutbox();
    server = await startAuthServer({ mailer });
    const a = new Browser(server, "198.51.100.68");
    await a.playToken();
    await a.saveWithEmail("slow@example.test");
    mailer.delayMs = 3000;
    const before = mailer.sent;
    const r = await publicAsk(server, "slow@example.test");
    expect(r.status).toBe(200);
    expect(r.ms).toBeLessThan(1500);
    expect(mailer.sent).toBe(before);
    await waitFor(() => mailer.sent === before + 1, 8000);
  });
});

/** A raw POST to /api/auth from a browser with no session (an attacker probing addresses). */
async function rawAuth(s: AuthServer, path: string, body: unknown, ip = "203.0.113.70") {
  const res = await new Browser(s, ip).fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.text() };
}

const authUserRow = (s: AuthServer, id: string) => s.accounts.authDb.prepare(`SELECT id FROM "user" WHERE id = ?`).get(id);

describe("Better Auth endpoints the game doesn't use are off (F12 final review S6, S8)", () => {
  it("a guest can't delete itself (its game.db rows and name would outlive the auth user); saving still removes the guest user", async () => {
    server = await startAuthServer();
    const b = new Browser(server, "198.51.100.90");
    const token = await b.playToken();
    const id = String(decodeJwt(token).sub);
    expect((await play(server, token)).json.ok).toBe(true);
    expect((await api(server, "/api/account/name", token, { body: { name: "Keeper" } })).json.ok).toBe(true);
    const del = await b.fetch("/api/auth/delete-anonymous-user", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(del.status).toBe(404);
    expect(authUserRow(server, id)).toBeTruthy();
    expect((await play(server, token)).json.ok).toBe(true);
    // Better Auth's post-link cleanup is a server-side call: the guest user still goes on save.
    await b.saveWithEmail("keeper@example.test");
    expect(authUserRow(server, id)).toBeUndefined();
  });

  it("every email-OTP and email/password endpoint the game doesn't call answers 404", async () => {
    server = await startAuthServer();
    const victim = new Browser(server, "198.51.100.92");
    await victim.playToken();
    await victim.saveWithEmail("victim@example.test");
    const body = { email: "victim@example.test", type: "forget-password", otp: "000000", newEmail: "other@example.test", password: "correct-horse-battery", newPassword: "correct-horse-battery", currentPassword: "x", token: "t" };
    const paths = [
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/change-password",
      "/verify-password",
    ];
    for (const path of paths) expect((await rawAuth(server, path, body)).status, path).toBe(404);
    const verify = await victim.fetch("/api/auth/verify-email?token=x");
    expect(verify.status).toBe(404);
    // What the game does use still works.
    expect((await rawAuth(server, "/email-otp/send-verification-otp", { email: "victim@example.test", type: "sign-in" })).status).toBe(200);
  });

  it("wrong, used-up and expired codes get one answer, whether or not the address is saved", async () => {
    server = await startAuthServer();
    const outbox = server.accounts.devOutbox!;
    const victim = new Browser(server, "198.51.100.93");
    await victim.playToken();
    await victim.saveWithEmail("victim@example.test");
    // A session-less attacker asks for a code (only the saved address gets one), then guesses.
    const guesses = async (email: string, ip: string) => {
      const before = outbox.sent;
      expect((await rawAuth(server!, "/email-otp/send-verification-otp", { email, type: "sign-in" }, ip)).status).toBe(200);
      if (email === "victim@example.test") await waitFor(() => outbox.sent > before);
      const wrong = outbox.lastCode(email) === "000000" ? "111111" : "000000";
      const out: { status: number; body: string }[] = [];
      for (let i = 0; i < 4; i++) out.push(await rawAuth(server!, "/sign-in/email-otp", { email, otp: wrong }, `${ip}${i}`));
      return out;
    };
    const saved = await guesses("victim@example.test", "203.0.113.71");
    const unknown = await guesses("nobody@example.test", "203.0.113.72");
    expect(saved).toEqual(unknown);
    expect(saved[0]!.status).toBe(400);

    // An expired code for a saved address looks like no code at all.
    const before = outbox.sent;
    await rawAuth(server, "/email-otp/send-verification-otp", { email: "victim@example.test", type: "sign-in" }, "203.0.113.73");
    await waitFor(() => outbox.sent > before);
    server.accounts.authDb.prepare(`UPDATE "verification" SET "expiresAt" = ? WHERE identifier = ?`).run(new Date(Date.now() - 60_000).toISOString(), "sign-in-otp-victim@example.test");
    const expired = await rawAuth(server, "/sign-in/email-otp", { email: "victim@example.test", otp: outbox.lastCode("victim@example.test")! }, "203.0.113.74");
    expect(expired).toEqual(unknown[0]);
  });

  it("a player who may save gets the same answer for saved and unknown addresses, whatever public requests did first", async () => {
    server = await startAuthServer();
    const outbox = server.accounts.devOutbox!;
    const victim = new Browser(server, "198.51.100.94");
    await victim.playToken();
    await victim.saveWithEmail("victim@example.test");
    // Public requests for a saved address are delivered (up to the hourly cap); for an unknown one nothing happens.
    const before = outbox.sent;
    for (const email of ["victim@example.test", "nobody@example.test"]) for (let i = 0; i < 3; i++) await rawAuth(server, "/email-otp/send-verification-otp", { email, type: "sign-in" }, "203.0.113.75");
    await waitFor(() => outbox.sent === before + 3);
    const attacker = new Browser(server, "203.0.113.76");
    await attacker.playToken();
    await attacker.levelUp(2);
    const a = await attacker.client.emailOtp.sendVerificationOtp({ email: "victim@example.test", type: "sign-in" });
    const b = await attacker.client.emailOtp.sendVerificationOtp({ email: "nobody@example.test", type: "sign-in" });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
  });
});

describe("one session can't drain the OTP budget (F12 final review S7)", () => {
  const ask = (b: Browser, email: string) => b.client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });

  it(`a player who may save gets ${OTP_PER_ACCOUNT_PER_DAY} codes a day, whatever its IP; other players are unaffected`, async () => {
    server = await startAuthServer({ rateLimit: true });
    const b = new Browser(server, "198.51.100.95");
    await b.playToken();
    await b.levelUp(2);
    for (let i = 0; i < OTP_PER_ACCOUNT_PER_DAY; i++) {
      b.ip = `203.0.113.${100 + i}`; // a new address every request (the per-IP cap doesn't help)
      expect((await ask(b, `drain${i}@example.test`)).error).toBeNull();
    }
    b.ip = "203.0.113.150";
    const over = await ask(b, "drain-over@example.test");
    expect(over.error).toMatchObject({ status: 429, code: "SAVING_BUSY" });
    expect(server.accounts.devOutbox!.lastCode("drain-over@example.test")).toBeNull();
    expect(otpSendsToday(server.accounts.db)).toBe(OTP_PER_ACCOUNT_PER_DAY);
    const other = new Browser(server, "198.51.100.96");
    await other.playToken();
    await other.levelUp(2);
    expect((await ask(other, "other@example.test")).error).toBeNull();
  });

  it("a failed send doesn't count against the player's daily cap", async () => {
    const mailer = new ControlledOutbox();
    server = await startAuthServer({ mailer });
    const b = new Browser(server, "198.51.100.97");
    await b.playToken();
    await b.levelUp(2);
    mailer.fail = true;
    for (let i = 0; i < OTP_PER_ACCOUNT_PER_DAY; i++) expect((await ask(b, `fail${i}@example.test`)).error?.status).toBe(503);
    mailer.fail = false;
    expect((await ask(b, "works@example.test")).error).toBeNull();
  });

  it("a banned account's session gets no code at all", async () => {
    server = await startAuthServer();
    const out = server.accounts.devOutbox!;
    const b = new Browser(server, "198.51.100.98");
    const id = String(decodeJwt(await b.playToken()).sub);
    await b.levelUp(2);
    const { banUser } = await import("../src/db/index.ts");
    banUser(server.accounts.db, { userId: id, ipHash: null, reason: "test" });
    const r = await ask(b, "banned-new@example.test");
    expect(r.error).toMatchObject({ status: 403, code: "BANNED" });
    // Not even through the public path for a saved address.
    const saver = new Browser(server, "198.51.100.99");
    await saver.playToken();
    await saver.saveWithEmail("saved-elsewhere@example.test");
    const sent = out.sent;
    expect((await ask(b, "saved-elsewhere@example.test")).error).toMatchObject({ status: 403, code: "BANNED" });
    expect(out.sent).toBe(sent);
    expect(otpSendsToday(server.accounts.db)).toBe(1);
  });
});

describe("requests without a session can't use up the OTP budget (F12 confirmation Opus SF2)", () => {
  /** Saved accounts made on earlier days (plain auth rows: making them through saves would use budget). */
  function savedAccounts(s: AuthServer, prefix: string, n: number): string[] {
    const now = new Date().toISOString();
    const ins = s.accounts.authDb.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "isAnonymous") VALUES (?, ?, ?, 1, ?, ?, 0)`);
    return Array.from({ length: n }, (_, i) => {
      const email = `${prefix}${i}@example.test`;
      ins.run(`${prefix}-${i}`, `${prefix}${i}`, email, now, now);
      return email;
    });
  }
  /** A public (session-less) code request from `ip`: the raw answer. */
  async function publicAsk(s: AuthServer, email: string, ip: string) {
    const res = await new Browser(s, ip).fetch("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, type: "sign-in" }) });
    return { status: res.status, body: await res.text() };
  }
  /** Count the background sends that were refused (each logs its budget), until every queued request is done. */
  function refusals() {
    const reasons: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((msg: unknown) => {
      const m = /^otp send refused: (\w+) budget$/.exec(String(msg));
      if (m) reasons.push(m[1]!);
    });
    return { reasons, restore: () => spy.mockRestore() };
  }

  it("the review's drain: 81 public asks for 27 owned addresses from 11 IPs use at most the public share, and saving still works", async () => {
    server = await startAuthServer({ otpDailyBudget: 80 });
    const out = server.accounts.devOutbox!;
    const owned = savedAccounts(server, "mine", 27);
    const log = refusals();
    try {
      const answers = new Set<string>();
      let n = 0;
      for (const email of owned) {
        for (let k = 0; k < 3; k++) {
          const r = await publicAsk(server, email, `203.0.113.${10 + Math.floor(n++ / 8)}`); // a new IP every 8 asks
          answers.add(`${r.status} ${r.body}`);
        }
      }
      expect([...answers]).toEqual([`200 ${JSON.stringify({ success: true })}`]); // one answer for all (no enumeration)
      await waitFor(() => out.sent + log.reasons.length === n);
      const share = Math.floor(80 * OTP_PUBLIC_SHARE);
      expect(out.sent).toBe(share);
      expect(log.reasons.filter((r) => r === "ip")).toHaveLength(9 * (8 - OTP_PUBLIC_PER_IP_PER_DAY)); // IPs 1–9 asked 8 times
      expect(otpSendsToday(server.accounts.db)).toBe(share);
    } finally {
      log.restore();
    }
    // A level-2 guest saving now still gets its code.
    const saver = new Browser(server, "198.51.100.77");
    await saver.playToken();
    await saver.levelUp(2);
    expect((await saver.client.emailOtp.sendVerificationOtp({ email: "legit@example.test", type: "sign-in" })).error).toBeNull();
    expect(out.lastCode("legit@example.test")).toMatch(/^\d{6}$/);
  });

  it(`one IP gets ${OTP_PUBLIC_PER_IP_PER_DAY} public codes a day; IPv6 counts per /64`, async () => {
    server = await startAuthServer();
    const out = server.accounts.devOutbox!;
    const owned = savedAccounts(server, "v6", 8);
    const log = refusals();
    try {
      // Two addresses in one /64 share a cap; the next /64 has its own.
      const ips = ["2001:db8:1:2::a", "2001:db8:1:2::a", "2001:db8:1:2::a", "2001:db8:1:2:ffff::b", "2001:db8:1:2::c", "2001:db8:1:2::d", "2001:db8:1:3::a", "203.0.113.200"];
      for (let i = 0; i < owned.length; i++) expect((await publicAsk(server, owned[i]!, ips[i]!)).status).toBe(200);
      await waitFor(() => out.sent + log.reasons.length === owned.length);
      expect(log.reasons).toEqual(["ip"]);
      expect(out.lastCode(owned[5]!)).toBeNull(); // the sixth from 2001:db8:1:2::/64
      expect(out.lastCode(owned[6]!)).toMatch(/^\d{6}$/);
      expect(out.lastCode(owned[7]!)).toMatch(/^\d{6}$/);
    } finally {
      log.restore();
    }
  });
});

describe("the auth proxy gate", () => {
  it("refuses /api/auth/* without the origin secret when ORIGIN_SECRET is set", async () => {
    server = await startAuthServer({ originSecret: "proxy-secret" });
    const direct = await fetch(`${server.base}/api/auth/get-session`);
    expect(direct.status).toBe(403);
    const wrong = await fetch(`${server.base}/api/auth/get-session`, { headers: { "x-origin-secret": "nope" } });
    expect(wrong.status).toBe(403);
    const b = new Browser(server);
    const token = await b.playToken();
    expect((await play(server, token)).json.ok).toBe(true);
    b.sendOriginSecret = false;
    expect((await b.client.token()).error?.status).toBe(403);
  });

  it("allows /api/auth/* without a secret in local dev and never caches auth responses", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    await b.playToken();
    for (const path of ["/api/auth/token", "/api/auth/jwks", "/api/auth/get-session"]) {
      const res = await b.fetch(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("load-test bot tokens", () => {
  it("are not available unless LOADTEST_SECRET is set", async () => {
    server = await startAuthServer();
    expect((await api(server, "/api/test/bot-token", null, { method: "POST", body: {} })).status).toBe(404);
  });

  it("need the x-loadtest-secret header, and give a loadtest identity", async () => {
    server = await startAuthServer({ loadtestSecret: "lt-secret" });
    expect((await api(server, "/api/test/bot-token", null, { method: "POST", body: {} })).status).toBe(403);
    expect((await api(server, "/api/test/bot-token", null, { method: "POST", body: {}, headers: { "x-loadtest-secret": "wrong" } })).status).toBe(403);
    const r = await api(server, "/api/test/bot-token", null, { method: "POST", body: { id: "bot7" }, headers: { "x-loadtest-secret": "lt-secret" } });
    expect(r.status).toBe(200);
    expect(r.json.userId).toBe("lt_bot7");
    const play1 = await play(server, r.json.token, { body: "arcadia", loadtest: true });
    expect(play1.json.ok).toBe(true);

    // A normal guest can't ask for a loadtest room.
    const guest = await new Browser(server).playToken();
    expect((await play(server, guest, { body: "arcadia", loadtest: true })).json).toEqual({ ok: false, error: "forbidden" });
  });

  it("bot tokens stop working when the load test ends (secret unset)", async () => {
    const dir = (await import("./auth-helpers.ts")).tempDir();
    server = await startAuthServer({ dir, loadtestSecret: "lt-secret" });
    const r = await api(server, "/api/test/bot-token", null, { method: "POST", body: {}, headers: { "x-loadtest-secret": "lt-secret" } });
    await server.close(true);
    server = await startAuthServer({ dir });
    expect((await play(server, r.json.token, { body: "arcadia", loadtest: true })).status).toBe(401);
  });
});

describe("rate limits (production rules)", () => {
  it("allows 20 guest sign-ins per minute per client IP, keyed on the proxy-forwarded address", async () => {
    server = await startAuthServer({ originSecret: "proxy-secret", rateLimit: true });
    const ip = "192.0.2.50";
    for (let i = 0; i < 20; i++) {
      const r = await new Browser(server, ip).client.signIn.anonymous();
      expect(r.error).toBeNull();
    }
    const over = await new Browser(server, ip).client.signIn.anonymous();
    expect(over.error?.status).toBe(429);
    expect((await new Browser(server, "192.0.2.51").client.signIn.anonymous()).error).toBeNull();
  });
});

describe("production safety", () => {
  it("refuses to boot in production with the dev secret", async () => {
    const { createAccounts, DEV_AUTH_SECRET } = await import("../src/auth/accounts.ts");
    const { tempDir } = await import("./auth-helpers.ts");
    const dir = tempDir();
    await expect(
      createAccounts({
        production: true, baseURL: "https://example.test", secret: DEV_AUTH_SECRET, authDbPath: `${dir}/a.db`, gameDbPath: `${dir}/g.db`,
        trustedOrigins: [], originSecret: "", emailFrom: "x <x@example.test>", resendKey: "", adminClaimToken: "", loadtestSecret: "",
        otpPerEmailPerHour: 3, otpDailyBudget: 10,
      }),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });

  it("without a Resend key in production, saving reports unavailable instead of pretending to send", async () => {
    server = await startAuthServer({ production: true, rateLimit: false });
    expect(server.accounts.mailer.kind).toBe("disabled");
    expect(server.accounts.devOutbox).toBeNull();
    const b = new Browser(server);
    await b.playToken();
    const r = await b.sendCode("prod@example.test");
    expect(r.error?.message).toBe("Saving is temporarily unavailable");
  });
});

// Seam 1: accounts over HTTP + SDK against the real server (Better Auth, game.db, /api/play).

import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { awardMedal, discoverPad, getAccount, loadCharacter, saveCharacter, type CharacterData } from "../src/db/index.ts";
import { otpSendsToday } from "../src/db/otp-budget.ts";
import type { AccountLinkedEvent } from "../src/auth/links.ts";
import { api, Browser, decodeJwt, joinWithToken, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

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
    expect(me).toMatchObject({ ok: true, userId: savedId, displayName: "Mira_7", guest: false, character: { level: 3, starter: "ember", palette: 2, body: "arcadia" }, medals: ["first-blood"], pads: [{ body: "arcadia", padId: "pad-north" }] });
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
    expect(out.sent).toBe(3);
    const code = out.lastCode("back@example.test")!;
    expect((await freshGuest.signInWithCode("back@example.test", code)).error).toBeNull();
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

  it("without a Resend key in production, saving reports busy instead of pretending to send", async () => {
    server = await startAuthServer({ production: true, rateLimit: false });
    expect(server.accounts.mailer.kind).toBe("disabled");
    expect(server.accounts.devOutbox).toBeNull();
    const b = new Browser(server);
    await b.playToken();
    const r = await b.sendCode("prod@example.test");
    expect(r.error?.message).toBe("Saving is busy, try again later");
  });
});

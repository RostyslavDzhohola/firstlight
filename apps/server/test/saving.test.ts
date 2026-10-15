// Saving can be unavailable (HANDOFF 5c): until Resend verifies the sending domain every code fails to
// send. The server names the failure (SAVING_UNAVAILABLE, SAVING_BUSY, EMAIL_REJECTED) so the save
// card can say so instead of waiting for a code that never comes, and it tells the client up front
// through GET /api/account/save-status.

import { afterEach, describe, expect, it } from "vitest";
import { classifyMailFailure, DevOutbox, MailHealth, type Mailer, type SendResult } from "../src/auth/mailer.ts";
import { Browser, decodeJwt, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** A mailer that answers like Resend: a switchable failure, else the dev outbox. */
class FlakyMailer extends DevOutbox {
  failure: { error: string; status?: number | null } | null = null;
  attempts = 0;
  constructor() {
    super(false);
  }
  override async sendOtp(email: string, otp: string): Promise<SendResult> {
    this.attempts++;
    if (this.failure) return { ok: false, ...this.failure };
    return super.sendOtp(email, otp);
  }
}

const UNVERIFIED = { error: "validation_error", status: 403 }; // "The … domain is not verified"

async function saveStatus(s: AuthServer): Promise<{ status: number; body: { ok: boolean; saving: string } }> {
  const res = await fetch(`${s.base}/api/account/save-status`);
  return { status: res.status, body: (await res.json()) as { ok: boolean; saving: string } };
}

/** The raw answer to a code request from a browser with no session (a returning player signing in). */
async function publicAsk(s: AuthServer, email: string, ip = "198.51.100.140") {
  const b = new Browser(s, ip);
  return b.client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
}

describe("mailer failures, as the save card hears them", () => {
  it("names the provider's errors: quota and rate limits are busy, a bad address is rejected, the rest is unavailable", () => {
    expect(classifyMailFailure({ error: "daily_quota_exceeded", status: 429 })).toBe("busy");
    expect(classifyMailFailure({ error: "monthly_quota_exceeded", status: 429 })).toBe("busy");
    expect(classifyMailFailure({ error: "rate_limit_exceeded", status: 429 })).toBe("busy");
    expect(classifyMailFailure({ error: "validation_error", status: 422 })).toBe("rejected"); // Invalid `to` field
    // The sending side: an unverified domain or a testing-only key (403), a bad or missing key, no network.
    expect(classifyMailFailure(UNVERIFIED)).toBe("unavailable");
    expect(classifyMailFailure({ error: "invalid_from_address", status: 422 })).toBe("unavailable");
    expect(classifyMailFailure({ error: "invalid_api_key", status: 403 })).toBe("unavailable");
    expect(classifyMailFailure({ error: "missing_api_key", status: 401 })).toBe("unavailable");
    expect(classifyMailFailure({ error: "network" })).toBe("unavailable");
    expect(classifyMailFailure({ error: "mail_not_configured" })).toBe("unavailable");
    expect(classifyMailFailure({ error: "internal_server_error", status: 500 })).toBe("unavailable");
  });

  it("health: down after a sending-side failure, back after a success or the hold; a rejected address changes nothing", () => {
    const mailer: Mailer = { kind: "resend", sendOtp: async () => ({ ok: true }) };
    const h = new MailHealth(mailer, 60_000);
    expect(h.state(0)).toBe("ok");
    h.record({ ok: false, error: "validation_error", status: 422 }, 0);
    expect(h.state(0)).toBe("ok");
    h.record({ ok: false, ...UNVERIFIED }, 1000);
    expect(h.state(1000)).toBe("unavailable");
    expect(h.state(60_999)).toBe("unavailable");
    expect(h.state(61_000)).toBe("ok");
    h.record({ ok: false, error: "daily_quota_exceeded", status: 429 }, 70_000);
    expect(h.state(70_000)).toBe("busy");
    h.record({ ok: true }, 71_000);
    expect(h.state(71_000)).toBe("ok");
    expect(new MailHealth({ kind: "disabled", sendOtp: async () => ({ ok: false, error: "mail_not_configured" }) }).state(0)).toBe("unavailable");
  });
});

describe("saving while mail is down", () => {
  it("an unverified sending domain answers SAVING_UNAVAILABLE (503), uses no budget, and recovers on the next good send", async () => {
    const mailer = new FlakyMailer();
    server = await startAuthServer({ mailer, otpPerEmailPerHour: 1 });
    expect(await saveStatus(server)).toEqual({ status: 200, body: { ok: true, saving: "ok" } });
    const b = new Browser(server, "198.51.100.141");
    await b.playToken();
    mailer.failure = UNVERIFIED;
    const r = await b.sendCode("down@example.test");
    expect(r.error).toMatchObject({ status: 503, code: "SAVING_UNAVAILABLE", message: "Saving is temporarily unavailable" });
    expect((await saveStatus(server)).body.saving).toBe("unavailable");
    // The domain gets verified: the next save goes through (the failure was released from the budget).
    mailer.failure = null;
    expect((await b.sendCode("down@example.test")).error).toBeNull();
    expect(mailer.lastCode("down@example.test")).toMatch(/^\d{6}$/);
    expect((await saveStatus(server)).body.saving).toBe("ok");
  });

  it("a provider quota answers SAVING_BUSY; an address the provider rejects answers 400 and leaves saving up", async () => {
    const mailer = new FlakyMailer();
    server = await startAuthServer({ mailer });
    const b = new Browser(server, "198.51.100.142");
    await b.playToken();
    mailer.failure = { error: "daily_quota_exceeded", status: 429 };
    expect((await b.sendCode("quota@example.test")).error).toMatchObject({ status: 503, code: "SAVING_BUSY" });
    expect((await saveStatus(server)).body.saving).toBe("busy");
    mailer.failure = { error: "validation_error", status: 422 };
    expect((await b.sendCode("odd@example.test")).error).toMatchObject({ status: 400, code: "EMAIL_REJECTED" });
    expect((await saveStatus(server)).body.saving).toBe("busy"); // unchanged by one bad address
  });

  it("while mail is down, every sign-in request gets the same SAVING_UNAVAILABLE, saved address or not (no enumeration)", async () => {
    const mailer = new FlakyMailer();
    server = await startAuthServer({ mailer });
    const saver = new Browser(server, "198.51.100.143");
    await saver.playToken();
    await saver.saveWithEmail("saved@example.test");
    const guest = new Browser(server, "198.51.100.144");
    await guest.playToken();
    mailer.failure = UNVERIFIED;
    expect((await guest.sendCode("new@example.test")).error?.code).toBe("SAVING_UNAVAILABLE");
    const before = mailer.attempts;
    const saved = await publicAsk(server, "saved@example.test");
    const unknown = await publicAsk(server, "nobody@example.test", "198.51.100.145");
    expect(saved.error).toMatchObject({ status: 503, code: "SAVING_UNAVAILABLE" });
    expect(unknown.error).toMatchObject({ status: 503, code: "SAVING_UNAVAILABLE" });
    expect(saved.error?.message).toBe(unknown.error?.message);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(mailer.attempts).toBe(before); // nothing was queued
  });

  it("a background (public) send that fails doesn't take saving down: only a player's own save reports health", async () => {
    const mailer = new FlakyMailer();
    server = await startAuthServer({ mailer });
    const saver = new Browser(server, "198.51.100.146");
    await saver.playToken();
    await saver.saveWithEmail("quiet@example.test");
    mailer.failure = UNVERIFIED;
    const before = mailer.attempts;
    expect((await publicAsk(server, "quiet@example.test")).error).toBeNull();
    await waitFor(() => mailer.attempts > before);
    expect((await saveStatus(server)).body.saving).toBe("ok");
    expect((await publicAsk(server, "nobody2@example.test", "198.51.100.147")).error).toBeNull();
  });

  it("production without a Resend key: saving is unavailable from the start", async () => {
    server = await startAuthServer({ production: true, rateLimit: false });
    expect((await saveStatus(server)).body.saving).toBe("unavailable");
    const b = new Browser(server);
    await b.playToken();
    expect((await b.sendCode("prod@example.test")).error).toMatchObject({ status: 503, code: "SAVING_UNAVAILABLE" });
  });
});

describe("GET /api/account/me tells a guest whether a code can be sent yet", () => {
  it("saveReady: a guest from level 2 (the server's code rule), never a saved player", async () => {
    server = await startAuthServer();
    const b = new Browser(server, "198.51.100.148");
    const me = async () => {
      const res = await fetch(`${server!.base}/api/account/me`, { headers: { Authorization: `Bearer ${await b.playToken()}` } });
      return (await res.json()) as { guest: boolean; saveReady: boolean };
    };
    expect(await me()).toMatchObject({ guest: true, saveReady: false });
    await b.levelUp(2);
    expect(await me()).toMatchObject({ guest: true, saveReady: true });
    await b.saveWithEmail("ready@example.test");
    expect(await me()).toMatchObject({ guest: false, saveReady: false });
  });
});

describe("a second browser restores the same starter (HANDOFF 5b)", () => {
  it("/api/account/me sends the starter as the index the game uses (not the stored id), equal to the room's", async () => {
    server = await startAuthServer();
    const a = new Browser(server, "198.51.100.150");
    const guestToken = await a.playToken();
    const guestId = String(decodeJwt(guestToken).sub);
    await a.levelUp(2);
    const { loadCharacter, saveCharacter } = await import("../src/db/index.ts");
    saveCharacter(server.accounts.db, guestId, { ...loadCharacter(server.accounts.db, guestId)!, starter: "kappa", palette: 4 });
    await a.saveWithEmail("kappa@example.test", "Kappa_Fan");

    // Browser B signs in with the same email: the client stores `character.starter` as fl.starter.
    const b = new Browser(server, "198.51.100.151");
    const out = server.accounts.devOutbox!;
    const before = out.sent;
    expect((await b.client.emailOtp.sendVerificationOtp({ email: "kappa@example.test", type: "sign-in" })).error).toBeNull();
    await waitFor(() => out.sent > before);
    expect((await b.signInWithCode("kappa@example.test", out.lastCode("kappa@example.test")!)).error).toBeNull();
    const token = await b.playToken();
    const me = (await (await fetch(`${server.base}/api/account/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { character: { starter: unknown; palette: number } };
    expect(me.character).toMatchObject({ starter: 2, palette: 4 }); // STARTERS[2] is Kappa
    expect(Number(String(me.character.starter))).toBe(2); // what the client puts in localStorage reads back

    // The rooms load the same row through SqliteCharacterRepo: the same starter as PlayerState.starter.
    const { SqliteCharacterRepo } = await import("../src/world/sqliteStores.ts");
    const accountId = String(decodeJwt(token).sub);
    expect(new SqliteCharacterRepo(server.accounts.db).load(accountId)?.starter).toBe(me.character.starter);
  });
});

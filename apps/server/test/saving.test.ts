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

describe("the OTP budget is no enumeration oracle across paths (Codex review)", () => {
  /** Near the cap, a saver's own send must answer the same whether a public probe hit a saved address. */
  async function probe(candidate: string) {
    const s = await startAuthServer({ otpDailyBudget: 3 }); // public share 1, saving share 2
    try {
      const owner = new Browser(s, "198.51.100.160");
      await owner.playToken();
      await owner.saveWithEmail("existing@example.test"); // saving: 1 of 2
      const attacker = new Browser(s, "198.51.100.161");
      await attacker.playToken();
      await attacker.levelUp();
      const out = s.accounts.devOutbox!;
      const before = out.sent;
      const pub = new Browser(s, "198.51.100.162");
      const q = await pub.client.emailOtp.sendVerificationOtp({ email: candidate, type: "sign-in" });
      if (candidate === "existing@example.test") await waitFor(() => out.sent > before); // the queued send went out
      const own = await attacker.sendCode("attacker@example.test"); // saving: 2 of 2
      const again = await attacker.sendCode("attacker2@example.test"); // saving: over its share either way
      return { publicError: q.error, own: own.error?.code ?? "sent", again: again.error?.code ?? "sent" };
    } finally {
      await s.close();
    }
  }

  it("a public probe of a saved address changes nothing a saver can see", async () => {
    const saved = await probe("existing@example.test");
    const unknown = await probe("unknown@example.test");
    expect(saved).toEqual(unknown);
    expect(saved).toEqual({ publicError: null, own: "sent", again: "SAVING_BUSY" });
  });
});

describe("saving from the death screen (Codex review, should-fix 1)", () => {
  it("the account's room re-sends the death, and respawn through it is answered with reborn", async () => {
    const { accountLinks } = await import("../src/auth/links.ts");
    const { liveSessions } = await import("../src/auth/sessions.ts");
    const { characterRepo } = await import("../src/world/characters.ts");
    const { SqliteCharacterRepo } = await import("../src/world/sqliteStores.ts");
    const { hub } = await import("../src/world/hub.ts");
    const { joinWithToken } = await import("./auth-helpers.ts");
    // The real link events, live sessions and SQLite characters, so the save moves the dead character
    // and closes the guest's room like production.
    server = await startAuthServer({ links: accountLinks, sessions: liveSessions });
    const prevRepo = characterRepo.current;
    characterRepo.current = new SqliteCharacterRepo(server.accounts.db);
    const rooms: { leave(): Promise<unknown> }[] = [];
    try {
      const b = new Browser(server, "198.51.100.170");
      const guestToken = await b.playToken();
      const guestId = String(decodeJwt(guestToken).sub);
      const old = await joinWithToken(server, guestToken);
      rooms.push(old);
      let closeCode = 0;
      old.onLeave((code: number) => (closeCode = code));
      let guestDeaths = 0;
      old.onMessage("death", () => guestDeaths++);
      await waitFor(() => !!hub.get(guestId));
      const ent = hub.get(guestId)!;
      const room = ent.room as unknown as { grantXp(a: unknown, n: number): void; kill(a: unknown, k: null): void };
      room.grantXp(ent.actor, 1000); // level 2+: may save
      room.kill(ent.actor, null);
      await waitFor(() => guestDeaths > 0);

      await b.saveWithEmail("deathsave@example.test"); // from the death screen
      await waitFor(() => closeCode !== 0);
      expect(closeCode).toBe(4101); // merged: the client rejoins as the account

      const accountToken = (await b.client.token()).data!.token;
      const accountId = String(decodeJwt(accountToken).sub);
      const next = await joinWithToken(server, accountToken);
      rooms.push(next);
      const seen: string[] = [];
      next.onMessage("death", () => seen.push("death"));
      next.onMessage("you", (m: { dead: boolean }) => seen.push(m.dead ? "you:dead" : "you:alive"));
      next.onMessage("reborn", () => seen.push("reborn"));
      await waitFor(() => seen.includes("death") && seen.includes("you:dead"));
      expect(hub.get(accountId)!.actor.dead).toBe(true);
      // Rise again: the client sends the pick through the room it's in now.
      next.send("respawn", { starter: 2, palette: 1 });
      await waitFor(() => seen.includes("reborn"));
    } finally {
      // The guest's room is already closed (4101): its leave() never settles, so don't wait long on any.
      for (const r of rooms) await Promise.race([r.leave().catch(() => {}), new Promise((ok) => setTimeout(ok, 500))]);
      characterRepo.current = prevRepo;
    }
  });
});

describe("review gaps (Codex): hostile origins and two tabs saving at once", () => {
  it("production refuses a cross-site request that carries the player's session (CSRF) over HTTP", async () => {
    server = await startAuthServer({ production: true, rateLimit: false });
    const b = new Browser(server, "198.51.100.180");
    await b.playToken(); // a guest session cookie
    const cookie = [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const ask = (origin: string) =>
      fetch(`${server!.base}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie, "x-forwarded-for": "198.51.100.180" },
        body: JSON.stringify({ email: "x@example.test", type: "sign-in" }),
      });
    expect((await ask("https://evil.example")).status).toBe(403);
    expect((await ask("http://localhost:5173")).status).not.toBe(403); // the trusted client origin gets an answer
  });

  it("two tabs saving the same guest at once: the character ends up in exactly one account", async () => {
    server = await startAuthServer();
    const { loadCharacter, saveCharacter } = await import("../src/db/index.ts");
    const b = new Browser(server, "198.51.100.181"); // one cookie jar: two tabs of one browser
    const guestId = String(decodeJwt(await b.playToken()).sub);
    await b.levelUp(3);
    const db = server.accounts.db;
    saveCharacter(db, guestId, { ...loadCharacter(db, guestId)!, coins: 77 });
    const out = server.accounts.devOutbox!;
    expect((await b.sendCode("tab1@example.test")).error).toBeNull();
    expect((await b.sendCode("tab2@example.test")).error).toBeNull();
    const [r1, r2] = await Promise.all([
      b.signInWithCode("tab1@example.test", out.lastCode("tab1@example.test")!),
      b.signInWithCode("tab2@example.test", out.lastCode("tab2@example.test")!),
    ]);
    const ids = [r1, r2].map((r) => (r.data as { user?: { id: string } } | null)?.user?.id).filter((x): x is string => !!x);
    expect(ids.length).toBeGreaterThan(0);
    const withCoins = ids.filter((id) => loadCharacter(db, id)?.coins === 77);
    expect(withCoins).toHaveLength(1); // moved once, never copied
    expect(loadCharacter(db, guestId)).toBeNull();
  });
});

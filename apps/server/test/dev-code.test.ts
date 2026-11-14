// #84: a local development server with no mail key sends no email; the save and sign-in cards fetch
// the code from GET /api/account/dev-code and show it. The route hands out anyone's sign-in code, so
// it exists only when someone deliberately opted in (DEV_SIGNIN_CODES=1, which `pnpm dev` sets), never
// in production, and answers only a caller on this machine: the socket's own address must be loopback,
// and no header a client or proxy can set makes a remote caller look local (review 2026-11-13 #1).

import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { accountsConfigFromEnv } from "../src/auth/accounts.ts";
import { localDevRequest } from "../src/auth/ip.ts";
import { DevOutbox } from "../src/auth/mailer.ts";
import { productionConfigProblems } from "../src/env.ts";
import { Browser, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const path = (email: string) => `/api/account/dev-code?email=${encodeURIComponent(email)}`;

/** GET the route at `host` (an address of this machine) with extra headers; status, headers and body. */
function get(s: AuthServer, host: string, email: string, headers: Record<string, string> = {}): Promise<{ status: number; cache: string | undefined; body: string }> {
  const port = s.game.port;
  return new Promise((ok, fail) => {
    const req = request({ host, port, path: path(email), method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, cache: res.headers["cache-control"], body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** An address of this machine that is not loopback (the LAN), or null when it has none. */
function outsideAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (!a.internal && a.family === "IPv4") return a.address;
  return null;
}
const lan = outsideAddress();

async function sendCode(s: AuthServer, email: string): Promise<string> {
  const b = new Browser(s);
  await b.playToken();
  const sent = await b.sendCode(email);
  expect(sent.error).toBeNull();
  const outbox = s.accounts.devOutbox!;
  await waitFor(() => outbox.lastCode(email) !== null);
  return outbox.lastCode(email)!;
}

/** Every header a client or a proxy could use to claim to be this machine. */
const LOOKS_LOCAL = {
  host: "localhost:2567",
  "x-forwarded-for": "127.0.0.1",
  "x-real-ip": "127.0.0.1",
  forwarded: "for=127.0.0.1;host=localhost",
  "x-forwarded-host": "localhost",
  origin: "http://localhost:5173",
};

describe("the code on a local development server (#84)", () => {
  it("is served to a caller on this machine after a send, never cached", async () => {
    server = await startAuthServer({ devCodeRoute: true });
    const code = await sendCode(server, "local@example.test");
    const res = await get(server, "127.0.0.1", "local@example.test");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ code });
    const none = await get(server, "127.0.0.1", "nobody@example.test");
    expect(JSON.parse(none.body)).toEqual({ code: null });
    expect(none.cache).toBe("no-store");
  });

  it("does not exist without the opt-in, even with NODE_ENV unset and no mail key", async () => {
    server = await startAuthServer(); // production: false, no resend key: the dev outbox is in use
    await sendCode(server, "staging@example.test");
    const res = await get(server, "127.0.0.1", "staging@example.test");
    expect(res.status).toBe(404);
    expect(res.body).not.toMatch(/"code"/);
  });

  it("never exists in production, with the opt-in, a dev outbox and a loopback caller", async () => {
    server = await startAuthServer({ production: true, rateLimit: false, mailer: new DevOutbox(), devCodeRoute: true });
    const res = await get(server, "127.0.0.1", "prod@example.test", LOOKS_LOCAL);
    expect(res.status).toBe(404);
    expect(res.body).not.toMatch(/"code"/);
  });

  it.skipIf(!lan)("refuses a caller from another address, whatever headers it sends", async () => {
    server = await startAuthServer({ devCodeRoute: true });
    await sendCode(server, "remote@example.test");
    const bare = await get(server, lan!, "remote@example.test");
    expect(bare.status).toBe(404);
    expect(bare.body).not.toMatch(/\d{6}/);
    const spoofed = await get(server, lan!, "remote@example.test", LOOKS_LOCAL);
    expect(spoofed.status).toBe(404);
    expect(spoofed.body).not.toMatch(/\d{6}/);
  });

  it("refuses a loopback hop that forwards someone else (a proxy on the same machine)", async () => {
    server = await startAuthServer({ devCodeRoute: true });
    await sendCode(server, "proxied@example.test");
    for (const h of [{ "x-forwarded-for": "203.0.113.9" }, { "x-real-ip": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }]) {
      const res = await get(server, "127.0.0.1", "proxied@example.test", h);
      expect(res.status, JSON.stringify(h)).toBe(404);
    }
  });

  it("refuses a page on another host name that resolved to this machine (DNS rebinding)", async () => {
    server = await startAuthServer({ devCodeRoute: true });
    await sendCode(server, "rebind@example.test");
    const res = await get(server, "127.0.0.1", "rebind@example.test", { host: "attacker.example:2567" });
    expect(res.status).toBe(404);
  });
});

describe("who counts as local", () => {
  const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as never;
  it("is decided by the socket's address", () => {
    expect(localDevRequest(req("127.0.0.1", { host: "localhost:2567" }))).toBe(true);
    expect(localDevRequest(req("::1", { host: "[::1]:2567" }))).toBe(true);
    expect(localDevRequest(req("::ffff:127.0.0.1", { host: "127.0.0.1:2567" }))).toBe(true);
    expect(localDevRequest(req("203.0.113.5", LOOKS_LOCAL))).toBe(false);
    expect(localDevRequest(req("10.0.0.2", LOOKS_LOCAL))).toBe(false);
    expect(localDevRequest(req(undefined, LOOKS_LOCAL))).toBe(false);
  });
});

describe("the switch", () => {
  const base = { production: false, authUrl: "", authSecret: "", authDbPath: "", gameDbPath: "", clientOrigins: [], originSecret: "", emailFrom: "", resendKey: "", adminClaimToken: "", loadtestSecret: "", otpDailyBudget: 1, otpPerEmailPerHour: 1, devMailLog: false };
  it("is off unless asked for", () => {
    expect(accountsConfigFromEnv(base).devCodeRoute).toBe(false);
    expect(accountsConfigFromEnv({ ...base, devCodeRoute: true }).devCodeRoute).toBe(true);
  });
  it("stops a production server from booting", () => {
    expect(productionConfigProblems({ DEV_SIGNIN_CODES: "1" }).join("\n")).toMatch(/DEV_SIGNIN_CODES/);
  });
  it("is on for `pnpm dev`, so the owner's local flow needs no step", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toMatch(/DEV_SIGNIN_CODES=1/);
    expect(pkg.scripts.start ?? "").not.toMatch(/DEV_SIGNIN_CODES/);
  });
});

// #84: a local development server with no mail key sends no email; the save and sign-in cards fetch
// the code from GET /api/account/dev-code and show it. The route hands out anyone's sign-in code, so
// it exists only when someone deliberately opted in (DEV_SIGNIN_CODES=1, which `pnpm dev` sets), never
// in production, and answers only a caller on this machine: the socket's own address must be loopback,
// and no header a client or proxy can set makes a remote caller look local (review 2026-11-13 #1).
// Round two (blocker 1): a header's absence proves nothing, so the code is readable only with the key
// the root `pnpm dev` generates for this run (tools/dev.ts) and hands to the server and Vite; without
// that key configured the route does not exist.

import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { buildClient, textFiles } from "../../../tools/eggs/bundle-guard.ts";
import { afterEach, describe, expect, it } from "vitest";
import { accountsConfigFromEnv } from "../src/auth/accounts.ts";
import { localDevRequest } from "../src/auth/ip.ts";
import { DevOutbox } from "../src/auth/mailer.ts";
import { productionConfigProblems } from "../src/env.ts";
import { Browser, ORIGIN, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
/** The run's key, as tools/dev.ts would generate it. */
const KEY = "k".repeat(10) + "Qw3rTy7uIoP9aSdFgHjKlZxCvBnM1234567890ab";
const WITH_KEY = { "x-firstlight-dev-key": KEY };
const devServer = (over: Parameters<typeof startAuthServer>[0] = {}) => startAuthServer({ devCodeRoute: true, devCodeKey: KEY, ...over });
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
  it("is served to a caller on this machine that holds the run's key, after a send, never cached", async () => {
    server = await devServer();
    const code = await sendCode(server, "local@example.test");
    const res = await get(server, "127.0.0.1", "local@example.test", WITH_KEY);
    expect(res.status).toBe(200);
    expect(res.cache).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ code });
    // The dev client's own page (a configured client origin) may ask too.
    expect((await get(server, "127.0.0.1", "local@example.test", { ...WITH_KEY, origin: ORIGIN })).status).toBe(200);
    const none = await get(server, "127.0.0.1", "nobody@example.test", WITH_KEY);
    expect(JSON.parse(none.body)).toEqual({ code: null });
    expect(none.cache).toBe("no-store");
  });

  it("does not exist without the opt-in, even with NODE_ENV unset and no mail key", async () => {
    server = await startAuthServer({ devCodeKey: KEY }); // production: false, no resend key: the dev outbox is in use
    await sendCode(server, "staging@example.test");
    const res = await get(server, "127.0.0.1", "staging@example.test", WITH_KEY);
    expect(res.status).toBe(404);
    expect(res.body).not.toMatch(/"code"/);
  });

  it("does not exist with the opt-in but no run key (a server not started by the root `pnpm dev`)", async () => {
    for (const devCodeKey of [undefined, "", "short-key"]) {
      server = await startAuthServer({ devCodeRoute: true, devCodeKey });
      await sendCode(server, "nokey@example.test");
      for (const h of [{}, WITH_KEY, { "x-firstlight-dev-key": devCodeKey ?? "" }]) {
        const res = await get(server, "127.0.0.1", "nokey@example.test", h);
        expect(res.status, `${devCodeKey} ${JSON.stringify(h)}`).toBe(404);
        expect(res.body).not.toMatch(/"code"/);
      }
      await server.close();
      server = null;
    }
  });

  // Review round two, blocker 1: a reverse proxy on this machine that connects over loopback, sets
  // the upstream Host to localhost:2567 and adds no forwarding header looks exactly like the developer.
  it("refuses a headerless same-machine proxy: without the key, with a wrong one, or from another site's page", async () => {
    server = await devServer();
    await sendCode(server, "proxy@example.test");
    const proxied = { host: "localhost:2567" };
    const tries: Record<string, string>[] = [
      proxied,
      { ...proxied, origin: "https://attacker.example" },
      { ...proxied, "x-firstlight-dev-key": "" },
      { ...proxied, "x-firstlight-dev-key": KEY.slice(0, -1) },
      { ...proxied, "x-firstlight-dev-key": `${KEY}x` },
      { ...proxied, "x-firstlight-dev-key": KEY.toUpperCase() },
      // The right key from another site's page (CORS, or a rebound name) is refused as well.
      { ...proxied, ...WITH_KEY, origin: "https://attacker.example" },
      { ...proxied, ...WITH_KEY, origin: "null" },
      { ...WITH_KEY, host: "attacker.example:2567" },
    ];
    for (const h of tries) {
      const res = await get(server, "127.0.0.1", "proxy@example.test", h);
      expect(res.status, JSON.stringify(h)).toBe(404);
      expect(res.body).not.toMatch(/\d{6}/);
      expect(res.cache).toBe("no-store");
    }
  });

  it("never exists in production, with the opt-in, a key, a dev outbox and a loopback caller", async () => {
    server = await startAuthServer({ production: true, rateLimit: false, mailer: new DevOutbox(), devCodeRoute: true, devCodeKey: KEY });
    const res = await get(server, "127.0.0.1", "prod@example.test", { ...LOOKS_LOCAL, ...WITH_KEY });
    expect(res.status).toBe(404);
    expect(res.body).not.toMatch(/"code"/);
  });

  it.skipIf(!lan)("refuses a caller from another address, whatever headers it sends", async () => {
    server = await devServer();
    await sendCode(server, "remote@example.test");
    const bare = await get(server, lan!, "remote@example.test", WITH_KEY);
    expect(bare.status).toBe(404);
    expect(bare.body).not.toMatch(/\d{6}/);
    const spoofed = await get(server, lan!, "remote@example.test", { ...LOOKS_LOCAL, ...WITH_KEY });
    expect(spoofed.status).toBe(404);
    expect(spoofed.body).not.toMatch(/\d{6}/);
  });

  it("refuses a loopback hop that forwards someone else (a proxy on the same machine)", async () => {
    server = await devServer();
    await sendCode(server, "proxied@example.test");
    const hops: Record<string, string>[] = [{ "x-forwarded-for": "203.0.113.9" }, { "x-real-ip": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }];
    for (const h of hops) {
      const res = await get(server, "127.0.0.1", "proxied@example.test", { ...h, ...WITH_KEY });
      expect(res.status, JSON.stringify(h)).toBe(404);
    }
  });

  it("refuses a page on another host name that resolved to this machine (DNS rebinding)", async () => {
    server = await devServer();
    await sendCode(server, "rebind@example.test");
    const res = await get(server, "127.0.0.1", "rebind@example.test", { host: "attacker.example:2567", ...WITH_KEY });
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
  it("is off unless asked for, and never carries a key in production", () => {
    expect(accountsConfigFromEnv(base).devCodeRoute).toBe(false);
    expect(accountsConfigFromEnv({ ...base, devCodeRoute: true }).devCodeRoute).toBe(true);
    expect(accountsConfigFromEnv({ ...base, devCodeRoute: true, devSigninKey: KEY }).devCodeKey).toBe(KEY);
    expect(accountsConfigFromEnv({ ...base, production: true, devCodeRoute: true, devSigninKey: KEY })).toMatchObject({ devCodeRoute: false, devCodeKey: "" });
  });
  it("stops a production server from booting", () => {
    expect(productionConfigProblems({ DEV_SIGNIN_CODES: "1" }).join("\n")).toMatch(/DEV_SIGNIN_CODES/);
    expect(productionConfigProblems({ DEV_SIGNIN_KEY: KEY }).join("\n")).toMatch(/DEV_SIGNIN_KEY/);
  });
  it("is on for the root `pnpm dev`, which makes a fresh key per run for the server and Vite, so the owner's local flow needs no step", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toMatch(/DEV_SIGNIN_CODES=1/);
    expect(pkg.scripts.start ?? "").not.toMatch(/DEV_SIGNIN_CODES|DEV_SIGNIN_KEY/);
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(root.scripts.dev).toBe("node tools/dev.ts");
    const { devEnv } = await import("../../../tools/dev.ts");
    const a = devEnv({ PATH: "/bin" });
    const b = devEnv({ PATH: "/bin" });
    expect(a.DEV_SIGNIN_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.DEV_SIGNIN_KEY).not.toBe(b.DEV_SIGNIN_KEY);
    expect(a.PATH).toBe("/bin");
    // A key the developer set (two processes started by hand) is kept when it is strong enough.
    expect(devEnv({ DEV_SIGNIN_KEY: KEY }).DEV_SIGNIN_KEY).toBe(KEY);
    expect(devEnv({ DEV_SIGNIN_KEY: "weak" }).DEV_SIGNIN_KEY).not.toBe("weak");
  });
  it("a production build holds neither the key nor the code fetch, even when the key is in its environment", { timeout: 300_000 }, () => {
    const was = process.env.DEV_SIGNIN_KEY;
    process.env.DEV_SIGNIN_KEY = KEY;
    const out = buildClient();
    try {
      const built = textFiles(out).filter((f) => f.endsWith(".js") || f.endsWith(".html"));
      expect(built.some((f) => f.endsWith(".js"))).toBe(true);
      const hits = built.filter((f) => /dev-code|x-firstlight-dev-key|__FL_DEV_SIGNIN_KEY__/.test(readFileSync(f, "utf8")) || readFileSync(f, "utf8").includes(KEY));
      expect(hits).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.DEV_SIGNIN_KEY;
      else process.env.DEV_SIGNIN_KEY = was;
      rmSync(out, { recursive: true, force: true });
    }
  });
  it("the dev client sends the key, which Vite gives only to the dev server, never to a build", () => {
    const vite = readFileSync(new URL("../../client/vite.config.ts", import.meta.url), "utf8");
    expect(vite).toMatch(/__FL_DEV_SIGNIN_KEY__:\s*JSON\.stringify\(command === "serve"/);
    const auth = readFileSync(new URL("../../client/src/net/auth.ts", import.meta.url), "utf8");
    expect(auth).toMatch(/"x-firstlight-dev-key"/);
  });
});

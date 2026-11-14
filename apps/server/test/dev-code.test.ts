// #84: outside production, with no mail key, no email goes out; the save and sign-in cards fetch the
// code from GET /api/account/dev-code and show it. Production never mounts that route.

import { afterEach, describe, expect, it } from "vitest";
import { DevOutbox } from "../src/auth/mailer.ts";
import { Browser, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const devCode = async (s: AuthServer, email: string) => fetch(`${s.base}/api/account/dev-code?email=${encodeURIComponent(email)}`);

describe("the code on a local server (#84)", () => {
  it("is served to the card after a send when no mail went out", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    await b.playToken();
    const sent = await b.sendCode("local@example.test");
    expect(sent.error).toBeNull();
    const outbox = server.accounts.devOutbox!;
    await waitFor(() => outbox.lastCode("local@example.test") !== null);
    const res = await devCode(server, "local@example.test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: outbox.lastCode("local@example.test") });
    expect(await (await devCode(server, "nobody@example.test")).json()).toEqual({ code: null });
  });

  it("never exists in production, even with a dev outbox injected", async () => {
    server = await startAuthServer({ production: true, rateLimit: false, mailer: new DevOutbox() });
    const res = await devCode(server, "prod@example.test");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/"code"/);
  });
});

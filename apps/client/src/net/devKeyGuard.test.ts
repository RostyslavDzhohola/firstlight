import { describe, expect, it } from "vitest";
import { localPage } from "./devKeyGuard.ts";

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers: { host: "localhost:5173", ...headers } });

describe("who the dev server gives the run's sign-in key to", () => {
  it("this machine's own page", () => {
    expect(localPage(req("127.0.0.1"))).toBe(true);
    expect(localPage(req("::1", { host: "[::1]:5173" }))).toBe(true);
    expect(localPage(req("::ffff:127.0.0.1", { host: "127.0.0.1:5611", "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("nobody else: a LAN neighbour, a proxy that says so, a rebound name, another site's page", () => {
    expect(localPage(req("192.168.1.20"))).toBe(false);
    expect(localPage(req("192.168.1.20", { "x-forwarded-for": "127.0.0.1" }))).toBe(false);
    expect(localPage(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe(false);
    expect(localPage(req("127.0.0.1", { via: "1.1 proxy" }))).toBe(false);
    expect(localPage(req("127.0.0.1", { host: "attacker.example:5173" }))).toBe(false);
    expect(localPage(req("127.0.0.1", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(localPage(req("127.0.0.1", { "sec-fetch-site": "same-site" }))).toBe(false);
  });
});

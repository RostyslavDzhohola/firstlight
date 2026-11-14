import { describe, expect, it } from "vitest";
import { Beacon, MAX_ERROR_KINDS, pageFlags, type BeaconEnv } from "./beacon.ts";

type Answer = { status: number; json: unknown } | null;

/** A fake page and server: storage, timers, and a server that issues visits and acknowledges steps. */
function env(over: Partial<BeaconEnv> = {}, server: (url: string, body: any) => Answer = defaultServer()) {
  const store = new Map<string, string>();
  const sent: { url: string; body: any }[] = [];
  const timers: (() => void)[] = [];
  const e: BeaconEnv = {
    apiUrl: "https://api.test",
    buildId: "b42",
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    post: async (url, body) => {
      const b = JSON.parse(body);
      sent.push({ url, body: b });
      return server(url, b);
    },
    enabled: true,
    automated: false,
    now: () => 1_000_000,
    later: (fn) => void timers.push(fn),
    ...over,
  };
  /** Run the timers and let the posts settle, until nothing is left. */
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const t = timers.splice(0);
      if (!t.length) continue;
      t.forEach((f) => f());
    }
  };
  const to = (path: string) => sent.filter((s) => s.url === `https://api.test${path}`);
  return { e, store, sent, timers, drain, to };
}

function defaultServer(): (url: string, body: any) => Answer {
  let n = 0;
  return (url, body) => {
    if (url.endsWith("/api/visit")) return { status: 200, json: { visit: body.prev ?? `tok${++n}`, exp: 1_000_000 + 86_400_000 } };
    if (url.endsWith("/api/funnel")) return { status: 200, json: { done: body.steps.map((s: { step: string }) => s.step) } };
    return { status: 204, json: null };
  };
}

describe("funnel beacon (#85)", () => {
  it("asks the server for a visit, batches first-time steps under it, and never sends a step twice", async () => {
    const t = env();
    const b = new Beacon(t.e);
    b.start();
    b.step("play");
    b.step("play");
    b.step("world", 12.345, "webgpu/medium");
    await t.drain();
    expect(t.to("/api/visit")).toEqual([{ url: "https://api.test/api/visit", body: { auto: false } }]);
    expect(t.to("/api/funnel")).toEqual([{ url: "https://api.test/api/funnel", body: { visit: "tok1", steps: [{ step: "play" }, { step: "world", value: 12.3, detail: "webgpu/medium" }] } }]);
    // A later page of the same browser: the same visit, and what it already sent stays sent.
    const again = new Beacon(t.e);
    again.start();
    again.step("play");
    again.step("tutorial:move", 0);
    await t.drain();
    expect(t.to("/api/visit")).toHaveLength(1); // the token is still live: no new request
    expect(t.to("/api/funnel")[1]!.body).toEqual({ visit: "tok1", steps: [{ step: "tutorial:move", value: 0 }] });
  });

  it("a delivery that fails keeps its steps and sends them again; only acknowledged steps count as sent (review #7)", async () => {
    let down = true;
    const t = env({}, (url, body) => (down && url.endsWith("/api/funnel") ? null : defaultServer()(url, body)));
    const b = new Beacon(t.e);
    b.start();
    b.step("play");
    await t.drain();
    expect(t.to("/api/funnel").length).toBeGreaterThanOrEqual(1); // tried
    expect(b.has("play")).toBe(false); // not acknowledged
    // The page closes before it gets through: the next page of this browser sends it.
    down = false;
    const next = new Beacon(t.e);
    next.start();
    await t.drain();
    const last = t.to("/api/funnel").at(-1)!;
    expect(last.body.steps).toEqual([{ step: "play" }]);
    expect(next.has("play")).toBe(true);
    // A rate-limited answer is retried later too, and a bad body is not.
    const limited = env({}, (url, body) => (url.endsWith("/api/funnel") ? { status: 429, json: {} } : defaultServer()(url, body)));
    const l = new Beacon(limited.e);
    l.start();
    l.step("pick");
    await limited.drain();
    expect(limited.to("/api/funnel").length).toBeGreaterThan(1);
    expect(limited.to("/api/funnel").length).toBeLessThanOrEqual(7); // bounded retries
  });

  it("an expired or refused visit token is renewed with the old one, and the steps go through", async () => {
    let refused = 1;
    const t = env({}, (url, body) => (url.endsWith("/api/funnel") && refused-- > 0 ? { status: 401, json: { error: "visit" } } : defaultServer()(url, body)));
    const b = new Beacon(t.e);
    b.start();
    b.step("play");
    await t.drain();
    expect(t.to("/api/visit").map((s) => s.body)).toEqual([{ auto: false }, { prev: "tok1", auto: false }]);
    expect(b.has("play")).toBe(true);
  });

  it("storage that throws: one visit per page, kept in memory (review #8)", async () => {
    const t = env({ store: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } } });
    const b = new Beacon(t.e);
    b.start();
    b.step("play");
    await t.drain();
    b.step("pick");
    await t.drain();
    b.error(new Error("boom"));
    await t.drain();
    expect(t.to("/api/visit")).toHaveLength(1);
    expect(new Set(t.sent.filter((s) => s.body.visit).map((s) => s.body.visit))).toEqual(new Set(["tok1"]));
    expect(t.to("/api/funnel").flatMap((s) => s.body.steps.map((x: { step: string }) => x.step))).toEqual(["play", "pick"]);
  });

  it("an automated page asks for a test visit (review #5)", async () => {
    const t = env({ automated: true });
    new Beacon(t.e).start();
    await t.drain();
    expect(t.to("/api/visit")[0]!.body).toEqual({ auto: true });
  });

  it("off (no server, Do Not Track, or the Privacy card's opt-out): nothing is asked for or sent (review #6)", async () => {
    const t = env({ enabled: false });
    const b = new Beacon(t.e);
    b.start();
    b.step("play");
    expect(b.error(new Error("boom"))).toBe(false);
    await t.drain();
    expect(t.sent).toHaveLength(0);
  });

  it("reports an error once per kind per session, with the build and renderer, capped, after the visit is issued", async () => {
    const t = env();
    const b = new Beacon(t.e);
    b.gfx = { backend: "webgl2", tier: "low" };
    const boom = (n: number) => Object.assign(new TypeError(`x is undefined at ${n}`), { stack: `TypeError: x is undefined at ${n}\n    at tick (https://x.test/Game.js:1:${n})` });
    expect(b.error(boom(1))).toBe(true); // before any visit: held until it is issued
    expect(b.error(boom(2))).toBe(false); // the same kind: numbers differ only
    await t.drain();
    expect(t.to("/api/client-error")[0]).toMatchObject({ body: { message: "TypeError: x is undefined at 1", build: "b42", backend: "webgl2", tier: "low", visit: "tok1" } });
    expect(b.error("ResizeObserver loop completed with undelivered notifications.")).toBe(false); // the browser's noise
    for (let i = 0; i < MAX_ERROR_KINDS + 3; i++) b.error(new Error(`kind ${"abcdefghijklmn"[i]}`));
    await t.drain();
    expect(t.to("/api/client-error")).toHaveLength(MAX_ERROR_KINDS);
    expect(JSON.stringify(t.to("/api/client-error")[0]!.body).length).toBeLessThan(1200);
  });

  it("scrubs a report before sending it: URL tokens and queries, encoded emails, rejected objects (review #3)", async () => {
    const t = env();
    const b = new Beacon(t.e);
    b.start();
    const err = Object.assign(new Error("Failed to fetch https://firstlight.test/reset-password/Zq81mK0pLx7vT3sYw9aBcD4e?token=sekret123abc#frag for player%40example.com"), {
      stack: "Error: Failed\n    at load (https://firstlight.test/assets/Game-abc.js?token=sekret123abc:10:20)\n    at https://firstlight.test/invite/Zq81mK0pLx7vT3sYw9aBcD4e:1:1\n    at a\n    at b\n    at c (x.js:1:1)\n    at d (y.js:1:1)\n    at e (z.js:1:1)",
    });
    b.error(err);
    b.error({ user: { email: "who@example.com", token: "abcDEF1234567890ghijKLMN" } }); // a promise rejected with an object
    await t.drain();
    const bodies = t.to("/api/client-error").map((s) => s.body);
    expect(bodies).toHaveLength(2);
    const text = JSON.stringify(bodies);
    for (const leak of ["Zq81mK0pLx7vT3sYw9aBcD4e", "sekret123abc", "#frag", "player", "example.com", "who@", "abcDEF1234567890ghijKLMN"]) expect(text, leak).not.toContain(leak);
    expect(bodies[0].message).toContain("https://firstlight.test/…");
    expect(bodies[0].stack).toContain("at load (https://firstlight.test/…/Game-abc.js:10:20)");
    expect(bodies[0].stack.split("\n").length).toBeLessThanOrEqual(5);
    expect(bodies[1].message).toBe("Unhandled rejection (Object)");
  });
});

describe("the page's flags", () => {
  it("automation (navigator.webdriver, ?e2e, ?bench) makes a test visit; Do Not Track, Global Privacy Control and the opt-out turn it off", () => {
    const base = { search: "", webdriver: false, doNotTrack: null, gpc: false, optOut: false, hasFetch: true };
    expect(pageFlags(base)).toEqual({ enabled: true, automated: false });
    expect(pageFlags({ ...base, webdriver: true }).automated).toBe(true);
    expect(pageFlags({ ...base, search: "?e2e" }).automated).toBe(true);
    expect(pageFlags({ ...base, search: "?bench&online" })).toEqual({ enabled: true, automated: true });
    expect(pageFlags({ ...base, search: "?bench" }).enabled).toBe(false); // offline bench: no server
    expect(pageFlags({ ...base, search: "?offline" }).enabled).toBe(false);
    expect(pageFlags({ ...base, doNotTrack: "1" }).enabled).toBe(false);
    expect(pageFlags({ ...base, gpc: true }).enabled).toBe(false);
    expect(pageFlags({ ...base, optOut: true }).enabled).toBe(false);
    expect(pageFlags({ ...base, doNotTrack: "0" }).enabled).toBe(true);
  });
});

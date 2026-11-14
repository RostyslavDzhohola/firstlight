import { describe, expect, it } from "vitest";
import { Beacon, MAX_ERROR_KINDS, type BeaconEnv } from "./beacon.ts";

function env(over: Partial<BeaconEnv> = {}) {
  const store = new Map<string, string>();
  const sent: { url: string; body: any }[] = [];
  const timers: (() => void)[] = [];
  const e: BeaconEnv = {
    apiUrl: "https://api.test",
    buildId: "b42",
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    send: (url, body) => void sent.push({ url, body: JSON.parse(body) }),
    enabled: true,
    now: () => 0,
    random: () => "visit-abcdefgh",
    later: (fn) => void timers.push(fn),
    ...over,
  };
  return { e, store, sent, run: () => timers.splice(0).forEach((f) => f()) };
}

describe("funnel beacon (#85)", () => {
  it("batches first-time steps into one post with the visit id, and never sends a step twice", () => {
    const t = env();
    const b = new Beacon(t.e);
    b.step("page");
    b.step("play");
    b.step("page");
    b.step("world", 12.345, "webgpu/medium");
    expect(t.sent).toHaveLength(0); // debounced
    t.run();
    expect(t.sent).toEqual([{ url: "https://api.test/api/funnel", body: { visit: "visit-abcdefgh", steps: [{ step: "page" }, { step: "play" }, { step: "world", value: 12.3, detail: "webgpu/medium" }] } }]);
    // A later page of the same browser: the steps it already sent stay sent.
    const again = new Beacon(t.e);
    again.step("page");
    again.step("tutorial:move", 0);
    t.run();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.body.steps).toEqual([{ step: "tutorial:move", value: 0 }]);
    expect(t.store.get("fl.visit")).toBe("visit-abcdefgh");
  });

  it("sends nothing when off (no server) and survives storage that throws", () => {
    const off = env({ enabled: false });
    new Beacon(off.e).step("page");
    off.run();
    expect(off.sent).toHaveLength(0);
    const broken = env({ store: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } });
    const b = new Beacon(broken.e);
    b.step("page");
    broken.run();
    expect(broken.sent).toHaveLength(1);
  });

  it("reports an error once per kind per session, with the build and renderer, capped", () => {
    const t = env();
    const b = new Beacon(t.e);
    b.gfx = { backend: "webgl2", tier: "low" };
    const boom = (n: number) => Object.assign(new TypeError(`x is undefined at ${n}`), { stack: `TypeError: x is undefined at ${n}\n    at tick (https://x.test/Game.js:1:${n})` });
    expect(b.error(boom(1))).toBe(true);
    expect(b.error(boom(2))).toBe(false); // the same kind: numbers differ only
    expect(t.sent[0]).toMatchObject({ url: "https://api.test/api/client-error", body: { message: "TypeError: x is undefined at 1", build: "b42", backend: "webgl2", tier: "low", visit: "visit-abcdefgh" } });
    expect(b.error("ResizeObserver loop completed with undelivered notifications.")).toBe(false); // the browser's noise
    for (let i = 0; i < MAX_ERROR_KINDS + 3; i++) b.error(new Error(`kind ${"abcdefghijklmn"[i]}`));
    expect(t.sent).toHaveLength(MAX_ERROR_KINDS);
    expect(JSON.stringify(t.sent[0]!.body).length).toBeLessThan(1200);
  });
});

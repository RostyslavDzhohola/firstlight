import { describe, expect, it } from "vitest";
import { CLOSE } from "@firstlight/shared/net/social";
import { ConnectionLost } from "./arrival.ts";
import { BootGate, describeBootFailure, RendererUnavailable, shouldKeepReconnecting } from "./boot.ts";

/** A deferred promise for driving one boot attempt by hand. */
function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("BootGate", () => {
  it("starts once on success; later calls are no-ops", async () => {
    let runs = 0;
    const gate = new BootGate(async () => {
      runs++;
    });
    expect(gate.state).toBe("idle");
    await gate.start();
    await gate.start();
    expect(runs).toBe(1);
    expect(gate.state).toBe("running");
  });

  it("shares one attempt between overlapping calls (double-click on Play)", async () => {
    const d = deferred();
    let runs = 0;
    const gate = new BootGate(() => {
      runs++;
      return d.promise;
    });
    const a = gate.start();
    const b = gate.start();
    expect(gate.state).toBe("booting");
    d.resolve();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it("a failed boot can be retried (the F12 S6 bug: the first failure blocked every retry)", async () => {
    let attempt = 0;
    const gate = new BootGate(async () => {
      attempt++;
      if (attempt === 1) throw new Error("server down");
    });
    await expect(gate.start()).rejects.toThrow("server down");
    expect(gate.state).toBe("failed");
    expect(gate.error).toBeInstanceOf(Error);
    await gate.start();
    expect(attempt).toBe(2);
    expect(gate.state).toBe("running");
    expect(gate.error).toBeNull();
  });
});

describe("describeBootFailure", () => {
  it("offers a retry when the server can't be reached or the connection dropped while arriving", () => {
    for (const e of [new TypeError("Failed to fetch"), new ConnectionLost(1006, "warming up"), new ConnectionLost(null, "waiting", true), new Error("play failed")]) {
      const f = describeBootFailure(e);
      expect(f?.action, String(e)).toBe("retry");
      expect(f!.title.length).toBeGreaterThan(0);
      expect(f!.text.length).toBeGreaterThan(0);
    }
  });

  it("explains a graphics failure", () => {
    const f = describeBootFailure(new RendererUnavailable(new Error("no adapter")));
    expect(f?.action).toBe("retry");
    expect(f?.text).toMatch(/WebGPU|WebGL/);
  });

  it("reloads the page when the game bundle didn't download (a failed import never retries)", () => {
    for (const m of ["Failed to fetch dynamically imported module: https://x/assets/Game-abc.js", "Importing a module script failed.", "error loading dynamically imported module"]) {
      expect(describeBootFailure(new TypeError(m))?.action).toBe("reload");
    }
  });

  it("stays quiet when the removal screen already explains (banned, kicked, playing elsewhere)", () => {
    expect(describeBootFailure(new Error("banned"))).toBeNull();
    expect(describeBootFailure(new Error("kicked"))).toBeNull();
    expect(describeBootFailure(new ConnectionLost(CLOSE.ELSEWHERE, "joining"))).toBeNull();
  });
});

describe("shouldKeepReconnecting", () => {
  it("keeps going through drops and timeouts, stops for refusals and removals", () => {
    expect(shouldKeepReconnecting(new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldKeepReconnecting(new ConnectionLost(1006, "joining"))).toBe(true);
    expect(shouldKeepReconnecting(new Error("banned"))).toBe(false);
    expect(shouldKeepReconnecting(new ConnectionLost(CLOSE.KICKED, "joining"))).toBe(false);
  });
});

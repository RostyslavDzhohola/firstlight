import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE } from "@firstlight/shared/net/social";
import { ArrivalWatch, closeAction, ConnectionLost, waitFor } from "./arrival.ts";

describe("closeAction", () => {
  it("rejoins after unexpected closes, stops for removals, stays out after logout", () => {
    expect(closeAction(1006)).toBe("rejoin"); // network drop
    expect(closeAction(4001)).toBe("rejoin"); // server shutting down (deploy)
    expect(closeAction(1000)).toBe("rejoin"); // only reported when we didn't leave ourselves
    expect(closeAction(CLOSE.MERGED)).toBe("rejoin-fresh");
    expect(closeAction(CLOSE.KICKED)).toBe("removed");
    expect(closeAction(CLOSE.BANNED)).toBe("removed");
    expect(closeAction(CLOSE.ELSEWHERE)).toBe("removed");
    expect(closeAction(CLOSE.LOGGED_OUT)).toBe("ignore");
  });
});

describe("ArrivalWatch", () => {
  it("passes checks until the room closes, then throws ConnectionLost with the first code", () => {
    const w = new ArrivalWatch();
    expect(() => w.check("building the world")).not.toThrow();
    w.onClose(1006);
    w.onClose(4000);
    expect(w.closed).toBe(true);
    try {
      w.check("warming up");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectionLost);
      expect((e as ConnectionLost).code).toBe(1006);
      expect((e as ConnectionLost).stage).toBe("warming up");
      expect((e as ConnectionLost).action).toBe("rejoin");
    }
  });

  it("reports a removal as such (no rejoin)", () => {
    const w = new ArrivalWatch();
    w.onClose(CLOSE.BANNED);
    expect(() => w.check("x")).toThrow(ConnectionLost);
    try {
      w.check("x");
    } catch (e) {
      expect((e as ConnectionLost).action).toBe("removed");
    }
  });
});

describe("waitFor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the probe's value once it shows up", async () => {
    let v: number | null = null;
    const p = waitFor(() => v, { stage: "joining", timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(300);
    v = 7;
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe(7);
  });

  it("rejects as soon as the watched room closes (no endless spinner)", async () => {
    const w = new ArrivalWatch();
    const p = waitFor(() => null, { stage: "waiting for our player", timeoutMs: 10_000, watch: w });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(200);
    w.onClose(1006);
    await vi.advanceTimersByTimeAsync(50);
    const e = await caught;
    expect(e).toBeInstanceOf(ConnectionLost);
    expect(e.code).toBe(1006);
  });

  it("gives up after the timeout", async () => {
    const p = waitFor(() => undefined, { stage: "waiting for our player", timeoutMs: 1000 });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1100);
    const e = await caught;
    expect(e).toBeInstanceOf(ConnectionLost);
    expect(e.timedOut).toBe(true);
    expect(e.action).toBe("rejoin");
  });
});

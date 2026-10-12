// The WebSocket half of a join is bounded (Codex finding 3): a socket that never finishes its room
// handshake fails the join, is closed, and a join that completes late is left, never attached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({ getPlayToken: async () => "token", invalidatePlayToken: () => {} }));

import { JOIN_TIMEOUT_MS, JoinTimeout, Net, type SeatJoiner } from "./Net.ts";

/** A fake room the SDK would hand back once joined. */
function fakeRoom() {
  return {
    sessionId: "s1",
    left: 0,
    leave() {
      this.left++;
      return Promise.resolve(4000);
    },
    onStateChange() {},
    onMessage() {
      return () => {};
    },
    onLeave() {},
    send() {},
  };
}

/** A joiner whose handshake completes only when the test says so (or never). */
function stallingJoiner() {
  const s = { aborted: 0, consumed: 0, complete: (_room: unknown) => {} };
  const joiner: SeatJoiner = {
    consume: () => {
      s.consumed++;
      const joined = new Promise<never>((resolve) => (s.complete = resolve as (r: unknown) => void));
      return { joined, abort: () => s.aborted++ };
    },
  };
  return { joiner, s };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => ({
    status: 200,
    json: async () => ({ ok: true, reservation: { name: "body", roomId: "r1", sessionId: "s1", processId: "p" } }),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Net.join (WebSocket handshake deadline)", () => {
  it("fails a handshake that never completes after the deadline and closes that socket", async () => {
    const { joiner, s } = stallingJoiner();
    const net = new Net(joiner);
    const caught = net.join("arcadia").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS - 100);
    expect(s.consumed).toBe(1);
    expect(s.aborted).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(await caught).toBeInstanceOf(JoinTimeout);
    expect(s.aborted).toBe(1);
    expect(net.room).toBeNull();
  });

  it("leaves a join that completes after the deadline instead of attaching it", async () => {
    const { joiner, s } = stallingJoiner();
    const net = new Net(joiner);
    const caught = net.join("arcadia").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS + 100);
    expect(await caught).toBeInstanceOf(JoinTimeout);
    const late = fakeRoom();
    s.complete(late);
    await vi.advanceTimersByTimeAsync(10);
    expect(late.left).toBe(1);
    expect(net.room).toBeNull();
  });

  it("doesn't attach a join that a leave() (or a newer join) superseded", async () => {
    const { joiner, s } = stallingJoiner();
    const net = new Net(joiner);
    const caught = net.join("arcadia").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    await net.leave(); // e.g. the arrival was abandoned and a retry starts
    const room = fakeRoom();
    s.complete(room);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBeInstanceOf(Error);
    expect(room.left).toBe(1);
    expect(net.room).toBeNull();
  });

  it("attaches a join that completes in time", async () => {
    const { joiner, s } = stallingJoiner();
    const net = new Net(joiner);
    const p = net.join("arcadia");
    await vi.advanceTimersByTimeAsync(100);
    const room = fakeRoom();
    s.complete(room);
    await expect(p).resolves.toBe(room);
    expect(net.room).toBe(room);
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS * 2);
    expect(s.aborted).toBe(0);
    expect(room.left).toBe(0);
    await net.leave();
  });
});

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

describe("Net remotes: who was already there (review A1)", () => {
  const player = (x: number) => ({ x, y: 1000, z: 0, fx: 1, fy: 0, fz: 0, anim: 0 });
  async function joined() {
    const { joiner, s } = stallingJoiner();
    const net = new Net(joiner);
    const p = net.join("portus");
    await vi.advanceTimersByTimeAsync(100);
    let onState: (state: unknown) => void = () => {};
    const room = { ...fakeRoom(), onStateChange: (fn: (state: unknown) => void) => void (onState = fn) };
    s.complete(room);
    await p;
    return { net, push: (players: Map<string, unknown>) => onState({ players }) };
  }

  it("marks everyone in the join snapshot as seeded, and only later joiners as new", async () => {
    const { net, push } = await joined();
    const players = new Map<string, unknown>([["s1", player(0)], ["a", player(1)], ["b", player(2)]]);
    push(players);
    expect(net.remotes.get("a")?.seeded).toBe(true);
    expect(net.remotes.get("b")?.seeded).toBe(true);
    expect(net.remotes.has("s1")).toBe(false);
    players.set("c", player(3));
    push(players);
    expect(net.remotes.get("c")?.seeded).toBe(false);
    expect(net.remotes.get("a")?.seeded).toBe(true);
    await net.leave();
  });

  it("keeps seeding until the state shows our own player, and seeds again on a rejoin", async () => {
    const { net, push } = await joined();
    // A first patch without us (never seen from the server, but nobody in it is an arrival).
    push(new Map<string, unknown>([["a", player(1)]]));
    push(new Map<string, unknown>([["a", player(1)], ["b", player(2)], ["s1", player(0)]]));
    expect(net.remotes.get("b")?.seeded).toBe(true);
    push(new Map<string, unknown>([["a", player(1)], ["b", player(2)], ["s1", player(0)], ["c", player(3)]]));
    expect(net.remotes.get("c")?.seeded).toBe(false);
    await net.leave();
    // The reconnect: a new room, and its snapshot (c included) is the room as we find it.
    const again = await joined();
    again.push(new Map<string, unknown>([["s1", player(0)], ["c", player(3)]]));
    expect(again.net.remotes.get("c")?.seeded).toBe(true);
    await again.net.leave();
  });
});

describe("Net.flushInput (the swing's heading reaches the server first)", () => {
  it("sends the frame's input the rate held back, before a message that reads the body's state", () => {
    const sent: { type: string; msg: any }[] = [];
    const net = new Net(stallingJoiner().joiner);
    const room = { send: (type: string, msg: unknown) => void sent.push({ type, msg }) };
    net.room = room as unknown as NonNullable<Net["room"]>;
    const m = { x: 0, y: 1000, z: 0, fx: 0, fy: 0, fz: 1, anim: 0 };
    net.sendInput(1000, m);
    expect(sent.map((s) => s.type)).toEqual(["input"]);
    // A turn 90° right 16 ms later: the 20 Hz rate holds the input back...
    m.fx = -1;
    m.fz = 0;
    net.sendInput(1016, m);
    expect(sent).toHaveLength(1);
    // ...until the swing flushes it, so the server's melee arc uses the camera's heading.
    net.flushInput(1016);
    room.send("melee", { slot: 0, t: 0 });
    expect(sent.map((s) => s.type)).toEqual(["input", "input", "melee"]);
    expect(sent[1]!.msg).toMatchObject({ fx: -1, fz: 0, seq: 2 });
    // Nothing held back: a flush sends nothing.
    net.flushInput(1020);
    expect(sent).toHaveLength(3);
  });
});

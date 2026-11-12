// attach() and a connection that goes away while it waits (review 2026-11-12 agent kit #2): a close()
// or a disconnect during the wait for the private state must not leave the agent "playing" with
// movement and ping timers running against a room it no longer has.

import { describe, expect, it } from "vitest";
import { FirstlightAgent } from "./agent.ts";
import { bodyWorld } from "./world.ts";

function fakeRoom() {
  const at = bodyWorld("arcadia").onGround([0.05, 1, 0.12]);
  const sent: string[] = [];
  const room = {
    sessionId: "s1",
    state: { players: new Map([["s1", { starter: 0, x: at[0], y: at[1], z: at[2], name: "Fake", agent: true, hp: 100, maxHp: 100, flags: 0 }]]), broken: new Set<string>() },
    left: 0,
    closed: (_code: number) => {},
    message: (_type: string, _m: unknown) => {},
    onMessage(_t: string, cb: (type: string, m: unknown) => void) {
      room.message = cb;
    },
    onStateChange() {},
    onLeave(cb: (code: number) => void) {
      room.closed = cb;
    },
    send(type: string) {
      sent.push(type);
    },
    async leave() {
      room.left++;
    },
  };
  return { room, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** attach() as join() calls it: for the join generation current at the call. */
const attach = (a: FirstlightAgent, room: unknown) => {
  const p = a as any;
  p.status = "joining";
  return p.attach(room, "arcadia", p.joinGen) as Promise<void>;
};
const timers = (a: FirstlightAgent) => [(a as any).timer, (a as any).pingTimer];

describe("attach and a connection that goes away meanwhile", () => {
  it("close() during the wait: stays closed, no timers, the room is let go", async () => {
    const a = new FirstlightAgent();
    const { room, sent } = fakeRoom();
    const joining = attach(a, room);
    joining.catch(() => {});
    await sleep(80); // the character is in the state; the private `you` hasn't come
    await a.close();
    await expect(joining).rejects.toMatchObject({ code: "superseded" });
    expect(a.status).toBe("closed");
    expect(timers(a)).toEqual([null, null]);
    expect((a as any).room).toBeNull();
    expect(room.left).toBeGreaterThan(0);
    await sleep(120);
    expect(sent).not.toContain("questSync");
    expect(sent).not.toContain("input");
  });

  it("a disconnect during the wait: the attach fails, nothing is playing, no second reconnect starts", async () => {
    const a = new FirstlightAgent();
    const { room, sent } = fakeRoom();
    const joining = attach(a, room);
    joining.catch(() => {});
    await sleep(80);
    room.closed(1006);
    await expect(joining).rejects.toMatchObject({ code: "join" });
    expect(a.status).toBe("joining"); // the caller of join() decides (connect: offline; reconnect: next try)
    expect(timers(a)).toEqual([null, null]);
    expect((a as any).room).toBeNull();
    expect((a as any).attaching).toBeNull();
    expect(sent).not.toContain("questSync");
  });

  it("a newer join during the wait supersedes the older attach without touching the newer room", async () => {
    const a = new FirstlightAgent();
    const first = fakeRoom();
    const second = fakeRoom();
    const older = attach(a, first.room);
    older.catch(() => {});
    await sleep(60);
    (a as any).joinGen++;
    const newer = attach(a, second.room);
    await expect(older).rejects.toMatchObject({ code: "superseded" });
    expect((a as any).room).toBe(second.room);
    second.room.message("you", { level: 1, hotbar: [], backpack: [] });
    await newer;
    expect(a.status).toBe("playing");
    expect(timers(a).every((t) => t !== null)).toBe(true);
    expect(first.room.left).toBeGreaterThan(0);
    expect(second.room.left).toBe(0);
    await a.close();
    expect(timers(a)).toEqual([null, null]);
  });
});

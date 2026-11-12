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

// Review 2026-11-12 (agent kit) #4: holding a beacon, the kit fought whatever was near, a person's
// fight included. threatNear() is what the defend helper picks its next creature with.
describe("holding a place: a person's creature is left alone", () => {
  it("skips a creature a person hit lately or that it yielded; takes an agent's or a free one", async () => {
    const a = new FirstlightAgent();
    const { room } = fakeRoom();
    const world = bodyWorld("arcadia");
    const self = room.state.players.get("s1")!;
    const centre: [number, number, number] = [self.x, self.y, self.z];
    const near = (east: number) => world.onGround([centre[0] + east, centre[1], centre[2]]);
    const npc = (east: number) => ({ kind: "hopbit", hp: 30, flags: 0, target: "s1", x: near(east)[0], y: near(east)[1], z: near(east)[2] });
    (room.state as any).npcs = new Map([["n1", npc(2)], ["n2", npc(4)], ["n3", npc(6)]]);
    (room.state.players as Map<string, unknown>).set("h1", { name: "Mira", agent: false, x: 0, y: 0, z: 0, flags: 0 });
    (room.state.players as Map<string, unknown>).set("a2", { name: "Scout", agent: true, x: 0, y: 0, z: 0, flags: 0 });
    const joining = attach(a, room);
    room.message("you", { level: 1, hotbar: [], backpack: [] });
    await joining;
    try {
      const p = a as any;
      const pick = (theirs?: Map<string, number>) => p.threatNear(centre, 30, theirs)?.id;
      expect(pick()).toBe("n1");
      p.claims.set("n1", { by: "h1", at: Date.now() }); // a person is fighting the nearest one
      expect(pick()).toBe("n2");
      p.claims.set("n2", { by: "a2", at: Date.now() }); // another agent's claim doesn't count ("people")
      expect(pick()).toBe("n2");
      expect(pick(new Map([["n2", Date.now() + 20_000]]))).toBe("n3"); // yielded a moment ago
      expect(pick(new Map([["n2", Date.now() - 1]]))).toBe("n2"); // ...and fair again after
      p.claims.set("n1", { by: "h1", at: Date.now() - 60_000 }); // the person left it long ago
      expect(pick()).toBe("n1");
    } finally {
      await a.close();
    }
  });
});

// Review 2026-11-12 (agent kit) #3: who counts as someone in the way of an attack.
describe("bystanders are people", () => {
  it("a person next to the target holds the attack; another agent, a dead player or the target itself doesn't", async () => {
    const a = new FirstlightAgent();
    const { room } = fakeRoom();
    const self = room.state.players.get("s1")!;
    const pos: [number, number, number] = [self.x, self.y, self.z];
    const up = pos.map((v) => v / Math.hypot(...pos)) as [number, number, number];
    const world = bodyWorld("arcadia");
    const ahead = world.onGround([pos[0] + 2, pos[1], pos[2]]);
    const players = room.state.players as Map<string, unknown>;
    const joining = attach(a, room);
    room.message("you", { level: 1, hotbar: [], backpack: [] });
    await joining;
    try {
      const p = a as any;
      const d = [ahead[0] - pos[0], ahead[1] - pos[1], ahead[2] - pos[2]];
      const k = d[0]! * up[0] + d[1]! * up[1] + d[2]! * up[2];
      const flat = [d[0]! - up[0] * k, d[1]! - up[1] * k, d[2]! - up[2] * k];
      const l = Math.hypot(...flat);
      const facing = flat.map((v) => v / l);
      const head = [pos[0] + up[0] * 1.6, pos[1] + up[1] * 1.6, pos[2] + up[2] * 1.6];
      const at = (skip = "") => p.bystander(p.weapon(), pos, head, facing, ahead, skip)?.name ?? null; // fists: 1.6 m, 70 degrees
      const near = { x: ahead[0], y: ahead[1], z: ahead[2], flags: 0 };
      expect(at()).toBeNull();
      players.set("a2", { ...near, name: "Scout", agent: true });
      expect(at()).toBeNull();
      players.set("d3", { ...near, name: "Fallen", agent: false, flags: 32 }); // PF.DEAD
      expect(at()).toBeNull();
      players.set("h1", { ...near, name: "Mira", agent: false });
      expect(at()).toBe("Mira");
      expect(at("h1")).toBeNull(); // the target of a pvp fight isn't its own bystander
    } finally {
      await a.close();
    }
  });
});

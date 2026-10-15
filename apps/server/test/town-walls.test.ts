// The Portus town's walls in combat (D-zones-3): shots, projectiles, blasts, NPC sight, NPC bolts
// and NPC strikes stop at the town's indestructible structures; whoever is inside the walls is
// protected at once, combat tag or not. Real rooms for players' attacks, the socket-free NPC world
// for the AI paths.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, zoneAt } from "@firstlight/shared";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { structureCollider } from "@firstlight/shared/planet/town";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { WEAPON_INDEX, WEAPONS } from "@firstlight/shared/content/weapons";
import { PF } from "@firstlight/shared/net/schema";
import { matchMaker } from "@colyseus/core";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { explode, fire, melee, projectiles, stepProjectiles, type Projectile } from "../src/world/combat.ts";
import { canSee, chest, startAttack } from "../src/world/npc/attacks.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { makeGround } from "../src/world/npc/steer.ts";
import { MODE } from "../src/world/npc/npc.ts";
import { fakeWorld } from "./npcWorld.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

type V = [number, number, number];
const R = BODIES.portus.radius;
const terrain = () => fakeWorld("portus").world.terrain;

/** Portus town coordinates (east, north) → planet space, `lift` metres above the ground. */
function town(east: number, north: number, lift = 0, t = terrain()): V {
  const d = townDir(east, north, R);
  const r = R + t.groundHeight(d[0], d[1], d[2]) + lift;
  return [d[0] * r, d[1] * r, d[2] * r];
}
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("players' attacks on the real path", () => {
  let game: Game;
  const rooms: Room[] = [];
  beforeEach(async () => {
    game = await startServer();
  });
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game.close();
    resetTuning();
  });
  const st = (r: Room) => r.state as any;
  const me = (r: Room) => st(r).players.get(r.sessionId);
  async function join(name: string, starter: number, at: V): Promise<Room> {
    const r = await joinAs(game, name, "portus", { starter }, "admin");
    rooms.push(r);
    await waitFor(() => !!me(r));
    r.send("admin", { cmd: "teleport", args: { x: at[0], y: at[1], z: at[2] } });
    r.send("admin", { cmd: "unprotect" });
    await waitFor(() => d3([me(r).x, me(r).y, me(r).z], at) < 1.5 && !(me(r).flags & PF.PROTECTED));
    return r;
  }
  /** A `fire` from the shooter's head at a point. */
  function shot(r: Room, at: V) {
    const s = me(r);
    const l = Math.hypot(s.x, s.y, s.z);
    const o: V = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
    const d = [at[0] - o[0], at[1] - o[1], at[2] - o[2]];
    const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
    return { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl, t: Date.now() };
  }

  it("a Hexquill bolt across the castle ward stops at its wall; the same bolt in the open hits", async () => {
    const a = await join("mage", 0, town(19, 50));
    const b = await join("mark", 3, town(-19, 50));
    expect(zoneAt(BODIES.portus, ...town(19, 50)).safe || zoneAt(BODIES.portus, ...town(-19, 50)).safe).toBe(false);
    const bursts: { x: number; y: number; z: number }[] = [];
    a.onMessage("explode", (m) => bursts.push(m));
    a.send("fire", shot(a, town(-19, 50, 1)));
    await waitFor(() => bursts.length > 0);
    // It burst against the ward's east wall (outer face ~2.6 m away), not on the far side.
    expect(d3([bursts[0]!.x, bursts[0]!.y, bursts[0]!.z], town(19, 50, 1.6))).toBeLessThan(4.5);
    await new Promise((ok) => setTimeout(ok, 600));
    expect(st(a).players.get(b.sessionId).hp).toBe(100);
    // Control: 24 m apart in the open north of the ward.
    for (const [r, p] of [[a, town(19, 70)], [b, town(-5, 70)]] as const) {
      r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
    }
    await waitFor(() => d3([me(b).x, me(b).y, me(b).z], town(-5, 70)) < 1.5 && d3([me(a).x, me(a).y, me(a).z], town(19, 70)) < 1.5);
    await new Promise((ok) => setTimeout(ok, 450)); // the Hexquill's fire rate
    a.send("fire", shot(a, town(-5, 70, 1)));
    await waitFor(() => st(a).players.get(b.sessionId).hp < 100);
  }, 30_000);

  it("Codex's repro: a combat-tagged player who runs inside the walls is protected at once, and the carbine from outside does nothing", async () => {
    const shooter = await join("outside", 3, town(57, -20));
    const target = await join("runner", 3, town(50, -20));
    // The runner fires first (a 10 s combat tag), then steps inside the walls.
    target.send("fire", shot(target, town(50, -10, 3)));
    await waitFor(() => !!(me(target).flags & PF.IN_COMBAT));
    const inside = town(33, -20);
    target.send("admin", { cmd: "teleport", args: { x: inside[0], y: inside[1], z: inside[2] } });
    await waitFor(() => d3([me(target).x, me(target).y, me(target).z], inside) < 1.5);
    await waitFor(() => !!(me(target).flags & PF.SAFE));
    expect(me(target).flags & PF.IN_COMBAT).toBeTruthy(); // still tagged, already safe (D-zones-3)
    for (let i = 0; i < 4; i++) {
      shooter.send("fire", shot(shooter, town(33, -20, 1)));
      await new Promise((ok) => setTimeout(ok, 300));
    }
    await new Promise((ok) => setTimeout(ok, 300));
    expect(st(shooter).players.get(target.sessionId).hp).toBe(100);
  }, 30_000);

  it("a move into the town counts before the next tick: a shot right after it does nothing, and the mover can't shoot out (both gates)", async () => {
    for (const s of [1, -1]) {
      const shooter = await join(`gun${s > 0 ? "e" : "w"}`, 3, town(s * 58, 0));
      const mover = await join(`mover${s > 0 ? "e" : "w"}`, 3, town(s * 46.4, 0));
      await waitFor(() => !(me(mover).flags & PF.SAFE));
      const room = matchMaker.getLocalRoomById(mover.roomId) as unknown as BodyRoom;
      const target = room.actors.get(mover.sessionId)!;
      const gun = room.actors.get(shooter.sessionId)!;
      gun.state.flags |= PF.SCOPED; // aimed: no spread to speak of
      const shotAt = (from: typeof gun, to: readonly number[]) => {
        const l = Math.hypot(from.state.x, from.state.y, from.state.z);
        const o = [from.state.x + (from.state.x / l) * 1.6, from.state.y + (from.state.y / l) * 1.6, from.state.z + (from.state.z / l) * 1.6];
        const tl = Math.hypot(to[0]!, to[1]!, to[2]!);
        const c = [to[0]! + (to[0]! / tl), to[1]! + (to[1]! / tl), to[2]! + (to[2]! / tl)];
        const d = [c[0]! - o[0]!, c[1]! - o[1]!, c[2]! - o[2]!];
        const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
        return { slot: 0, ox: o[0]!, oy: o[1]!, oz: o[2]!, dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl, t: Date.now() };
      };
      // Control: on the wild side of the border the shot lands.
      const hp0 = target.state.hp;
      expect(fire(room.host, gun, shotAt(gun, [target.state.x, target.state.y, target.state.z]))).toEqual({ ok: true });
      expect(target.state.hp).toBeLessThan(hp0);
      target.state.hp = target.state.maxHp;
      gun.lastAttackAt = 0;
      // One synchronous run, no tick between: the accepted move onto the border, then the shot.
      const to = town(s * 46, 0);
      room.handleInput({ sessionId: mover.sessionId, send: () => {} } as never, { seq: target.state.seq + 1, x: to[0], y: to[1], z: to[2], fx: 0, fy: 0, fz: 1, anim: 0, t: Date.now() });
      expect(d3([target.state.x, target.state.y, target.state.z], to)).toBeLessThan(0.01); // accepted
      expect(target.state.flags & PF.SAFE).toBeFalsy(); // the tick hasn't written the flag yet
      expect(fire(room.host, gun, shotAt(gun, to))).toEqual({ ok: true });
      expect(target.state.hp).toBe(target.state.maxHp);
      expect(fire(room.host, target, shotAt(target, [gun.state.x, gun.state.y, gun.state.z]))).toEqual({ ok: false, reason: "safe zone" });
    }
  }, 30_000);

  it("a Comet fired from outside the east gate at someone standing in it does no damage", async () => {
    const shooter = await join("rocket", 3, town(60, 0));
    const target = await join("gatekeeper", 1, town(44, 0));
    await waitFor(() => !!(me(target).flags & PF.SAFE));
    let you: any = null;
    shooter.onMessage("you", (m) => (you = m));
    shooter.send("admin", { cmd: "give", args: { id: "comet" } });
    await waitFor(() => !!you?.hotbar?.some((it: any) => it?.id === "comet"));
    const slot = you.hotbar.findIndex((it: any) => it?.id === "comet");
    const fired: any[] = [];
    shooter.onMessage("projectile", (m) => m.by === shooter.sessionId && fired.push(m));
    // Through the open gate at the gatekeeper's chest (the rocket flies on, past them), then at the
    // wall beside the gate with the gatekeeper 2 m behind it.
    shooter.send("fire", { ...shot(shooter, town(44, 0, 1)), slot });
    await waitFor(() => fired.length === 1);
    await new Promise((ok) => setTimeout(ok, 2000)); // reload 1.8 s
    shooter.send("fire", { ...shot(shooter, town(44.5, 4.5, 1)), slot });
    await waitFor(() => fired.length === 2);
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(st(shooter).players.get(target.sessionId).hp).toBe(100);
  }, 30_000);
});

describe("the AI and blasts (socket-free NPC world on Portus)", () => {
  beforeEach(() => {
    NPC_TUNING.ambient = false; // only the NPCs each test places
  });
  afterEach(() => resetTuning());
  /** A Portus NPC world whose combat host knows the town's walls, as BodyRoom sets it up. */
  function walled() {
    const fw = fakeWorld("portus");
    fw.world.host.walls = structureCollider(fw.world.terrain)!;
    return fw;
  }

  it("NPC sight: not through the castle ward, fine in the open", () => {
    const fw = walled();
    const t = fw.world.terrain;
    expect(canSee(fw.sys, town(17.5, 50, 2, t), town(-17.5, 50, 1.4, t))).toBe(false);
    expect(canSee(fw.sys, town(17.5, 70, 2, t), town(-5, 70, 1.4, t))).toBe(true);
  });

  it("an Associate across the ward never notices the player; in the open it does", () => {
    for (const [north, expectSeen] of [[50, false], [70, true]] as const) {
      const fw = walled();
      const t = fw.world.terrain;
      const p = fw.addPlayer("p", town(-12, north, 0, t));
      fw.movePlayer(p, north === 50 ? town(-17, 50, 0, t) : town(-5, 70, 0, t));
      const n = fw.sys.createNpc(NPC_INDEX.get("associate")!, 12, town(17, north, 0, t), fw.clock.t, { instant: true, roam: 0 });
      // Face the player.
      const tp = [p.state.x - n.pos[0], p.state.y - n.pos[1], p.state.z - n.pos[2]];
      const u = n.pos.map((v) => v / Math.hypot(...n.pos));
      const k = tp[0]! * u[0]! + tp[1]! * u[1]! + tp[2]! * u[2]!;
      const f = [tp[0]! - u[0]! * k, tp[1]! - u[1]! * k, tp[2]! - u[2]! * k];
      const fl = Math.hypot(...f);
      n.facing = [f[0]! / fl, f[1]! / fl, f[2]! / fl];
      for (let i = 0; i < 60; i++) fw.step(50);
      expect(!!n.target, `north ${north}`).toBe(expectSeen);
    }
  });

  it("an NPC bolt flying at the ward's wall stops there; the player behind it is untouched", () => {
    const fw = walled();
    const t = fw.world.terrain;
    const behind = fw.addPlayer("behind", town(13, 50, 0, t)); // just inside the wall (the fake world sets no SAFE flag)
    const n = fw.sys.createNpc(NPC_INDEX.get("sparkfly")!, 2, town(24, 50, 0, t), fw.clock.t, { instant: true, roam: 0 });
    const from = town(24, 50, 1.2, t);
    const to = chest([behind.state.x, behind.state.y, behind.state.z]);
    const v = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const vl = Math.hypot(...v);
    fw.sys.projectiles.push({ owner: n, pos: from, vel: [(v[0]! / vl) * 12, (v[1]! / vl) * 12, (v[2]! / vl) * 12], g: 0, until: fw.clock.t + 5000, radius: 0.5, damage: 30 });
    for (let i = 0; i < 40 && fw.sys.projectiles.length; i++) fw.step(50);
    expect(fw.sys.projectiles).toHaveLength(0);
    expect(behind.state.hp).toBe(behind.state.maxHp);
    // Control: the same bolt with no wall in the way.
    fw.movePlayer(behind, town(13, 70, 0, t));
    const to2 = chest([behind.state.x, behind.state.y, behind.state.z]);
    const from2 = town(24, 70, 1.2, t);
    const w = [to2[0] - from2[0], to2[1] - from2[1], to2[2] - from2[2]];
    const wl = Math.hypot(...w);
    fw.sys.projectiles.push({ owner: n, pos: from2, vel: [(w[0]! / wl) * 12, (w[1]! / wl) * 12, (w[2]! / wl) * 12], g: 0, until: fw.clock.t + 5000, radius: 0.5, damage: 30 });
    for (let i = 0; i < 40 && fw.sys.projectiles.length; i++) fw.step(50);
    expect(behind.state.hp).toBeLessThan(behind.state.maxHp);
  });

  it("an NPC strike doesn't reach through the wall: a Crypt Sentinel's mace ring outside the ward misses the player inside", () => {
    for (const [north, hurt] of [[52, false], [70, true]] as const) {
      const fw = walled();
      const t = fw.world.terrain;
      const p = fw.addPlayer("p", town(13.4, north, 0, t));
      const n = fw.sys.createNpc(NPC_INDEX.get("crypt_sentinel")!, 10, town(17, north, 0, t), fw.clock.t, { instant: true, roam: 0 });
      fw.step(50);
      const mace = n.def.attacks.findIndex((a) => a.id === "mace");
      startAttack(fw.sys, n, mace, p, fw.clock.t);
      for (let i = 0; i < 60; i++) fw.step(50);
      expect(p.state.hp < p.state.maxHp, `north ${north}`).toBe(hurt);
    }
  });

  it("a blast against the ward's wall hurts the near side only; a Comet hitting the wall bursts on the near side", () => {
    const fw = walled();
    const t = fw.world.terrain;
    const near = fw.addPlayer("near", town(18.8, 50, 0, t));
    const far = fw.addPlayer("far", town(13.4, 50, 0, t)); // inside the wall, 2.8 m of stone between
    const owner = fw.addPlayer("owner", town(40, 50, 0, t));
    explode(fw.world.host, owner, town(16.6, 50, 1, t), 4, 50, WEAPON_INDEX.get("comet")!);
    expect(near.state.hp).toBeLessThan(near.state.maxHp);
    expect(far.state.hp).toBe(far.state.maxHp);

    near.state.hp = near.state.maxHp;
    const comet = WEAPONS[WEAPON_INDEX.get("comet")!]!;
    const from = town(24, 50, 1.2, t);
    const to = town(10, 50, 1.2, t);
    const v = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const vl = Math.hypot(...v);
    const pr: Projectile = {
      id: 9_999, owner, weapon: comet, tier: comet.tiers[0]!, damage: 70, pos: from, vel: [(v[0]! / vl) * 30, (v[1]! / vl) * 30, (v[2]! / vl) * 30],
      gravity: 0, travelled: 0, maxDist: 96, pierceLeft: 0, hit: new Set([owner.id]), fuseAt: null, stuck: false,
    };
    projectiles(fw.world.host).push(pr);
    for (let i = 0; i < 20 && projectiles(fw.world.host).length; i++) stepProjectiles(fw.world.host, 0.05);
    expect(projectiles(fw.world.host)).toHaveLength(0);
    expect(near.state.hp).toBeLessThan(near.state.maxHp); // 2.2 m from the impact, same side
    expect(far.state.hp).toBe(far.state.maxHp);
  });

  it("a charged hammer slam doesn't reach through the wall (the arc's own targets never did)", () => {
    for (const [north, hurt] of [[52, false], [70, true]] as const) {
      const fw = walled();
      const t = fw.world.terrain;
      const smith = fw.addPlayer("smith", town(17, north, 0, t), 12);
      const other = fw.addPlayer("other", town(13.3, north, 0, t), 12); // 3.7 m off: inside the slam's 4 m
      smith.char.hotbar[0] = { id: "hammer", tier: 3, qty: 1 };
      smith.char.selected = 0;
      smith.chargeStartedAt = fw.clock.t - 1100; // charged for 1.1 s
      expect(melee(fw.world.host, smith, true)).toEqual({ ok: true });
      expect(other.state.hp < other.state.maxHp, `north ${north}`).toBe(hurt);
    }
  });

  it("NPCs walk round the structures outside the walls: a Woolback heading through the crates by the east road gets past them", () => {
    for (const [from, to] of [[[52.5, -6], [58.5, -6]], [[58.5, -6.4], [52.5, -5.6]]] as const) {
      const fw = walled();
      const t = fw.world.terrain;
      const col = makeGround(t).structures!;
      const goal = town(to[0], to[1], 0, t);
      // The crates stand on the straight line between the two spots.
      expect(col.crosses(...town(from[0], from[1], 0, t), ...goal)).toBe(true);
      const n = fw.sys.createNpc(NPC_INDEX.get("woolback")!, 1, town(from[0], from[1], 0, t), fw.clock.t, { instant: true, roam: 0 });
      n.goal = goal;
      fw.sys.setMode(n, MODE.WANDER, fw.clock.t);
      let arrived = false;
      for (let i = 0; i < 400 && !arrived; i++) {
        fw.step(50);
        expect(col.footing(n.pos[0], n.pos[1], n.pos[2], 0.3).inside, `tick ${i}`).toBe(false);
        arrived = n.goal === null; // moveTo arrived (within 1 m) and the Woolback went idle
      }
      expect(arrived, `from ${from} to ${to}`).toBe(true);
      expect(d3(n.pos, goal)).toBeLessThan(1.6);
    }
  });
});

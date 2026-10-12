// Seam 1: enemies, wildlife and bosses, observed through real rooms and SDK bot clients.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, isSafe, padDirs, type BodyId } from "@firstlight/shared";
import { bossArena, resolveAreaDir } from "@firstlight/shared/content/arenas";
import { NF, NPC_ANIM, NPC_AREAS } from "@firstlight/shared/content/npcs";
import type { Game } from "../src/app.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

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

type V = [number, number, number];
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const d3 = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
/** Horizontal distance (along the surface, ignoring height). */
const flat = (a: number[], b: number[]) => {
  const la = Math.hypot(a[0]!, a[1]!, a[2]!), lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  return Math.hypot(a[0]! / la - b[0]! / lb, a[1]! / la - b[1]! / lb, a[2]! / la - b[2]! / lb) * la;
};

/** A point `metres` from a pad along a fixed tangent (plus `sideways`), on the sphere surface. */
function nearPad(body: BodyId, pad: number, metres: number, sideways = 0): V {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[pad]!;
  return offset([d[0] * R, d[1] * R, d[2] * R], metres, sideways, R);
}

function offset(p: number[], metres: number, sideways: number, R: number): V {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  const d = [p[0]! / l, p[1]! / l, p[2]! / l];
  const ref = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0]! + ref[1]! * d[1]! + ref[2]! * d[2]!;
  let t = [ref[0]! - k * d[0]!, ref[1]! - k * d[1]!, ref[2]! - k * d[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  t = t.map((v) => v / tl);
  const s = [d[1]! * t[2]! - d[2]! * t[1]!, d[2]! * t[0]! - d[0]! * t[2]!, d[0]! * t[1]! - d[1]! * t[0]!];
  const v = [d[0]! + (t[0]! * metres + s[0]! * sideways) / R, d[1]! + (t[1]! * metres + s[1]! * sideways) / R, d[2]! + (t[2]! * metres + s[2]! * sideways) / R];
  const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / vl) * R, (v[1]! / vl) * R, (v[2]! / vl) * R];
}

async function player(name: string, body: BodyId, at: V, level = 1): Promise<Room> {
  const r = await joinAs(game, name, body, { starter: 3 }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  r.send("admin", { cmd: "level", args: { level } });
  place(r, at);
  // Wait for the teleport and for the next tick to clear SAFE (1) and PROTECTED (2).
  await waitFor(() => flat([me(r).x, me(r).y, me(r).z], at) < 2 && !(me(r).flags & 3));
  return r;
}

function place(r: Room, p: V) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
}

let reqSeq = 0;
/** Send an admin `npc` command and wait for the reply of `type`. */
function ask<T = any>(r: Room, type: string, msg: Record<string, unknown>): Promise<T> {
  const req = ++reqSeq;
  return new Promise((ok, fail) => {
    const off = r.onMessage(type, (m: any) => {
      if (m.req !== req) return;
      (off as unknown as () => void)?.();
      ok(m);
    });
    r.send("npc", { ...msg, req });
    setTimeout(() => fail(new Error(`no ${type} reply`)), 3000);
  });
}

const spawn = (r: Room, kind: string, at: V, extra: Record<string, unknown> = {}) => ask<{ id: string }>(r, "npcInfo", { cmd: "spawn", kind, x: at[0], y: at[1], z: at[2], ...extra }).then((m) => m.id);
const list = (r: Room) => ask<{ npcs: any[]; tickMs: number }>(r, "npcList", { cmd: "list" }).then((m) => m.npcs);
const bossInfo = (r: Room, action = "info") => ask<any>(r, "bossInfo", { cmd: "boss", action });
const npcOf = async (r: Room, id: string) => (await list(r)).find((n) => n.id === id);

describe("enemies and wildlife (seam 1)", () => {
  it("spawn near a player on Arcadia, never inside a safe zone, and stream to clients nearby", async () => {
    NPC_TUNING.ambient = true;
    const area = NPC_AREAS.find((a) => a.id === "clover_fields")!;
    const d = resolveAreaDir(BODIES.arcadia, area.at);
    const R = BODIES.arcadia.radius;
    const at = offset([d[0] * R, d[1] * R, d[2] * R], 0, 0, R);
    const a = await player("scout", "arcadia", at);
    let npcs: any[] = [];
    await waitFor(() => {
      void list(a).then((l) => (npcs = l));
      return npcs.length >= 4;
    }, 5000);
    for (const n of npcs) {
      expect(isSafe(BODIES.arcadia, n.x, n.y, n.z), `${n.def} at a pad`).toBe(false);
      // Woken by the player: near Clover Fields, or near the main pad where they joined before teleporting.
      const nearest = Math.min(d3([n.x, n.y, n.z], at), d3([n.x, n.y, n.z], nearPad("arcadia", 0, 0)));
      expect(nearest).toBeLessThan(NPC_TUNING.activateRadius + 30);
    }
    // The client's view holds the nearby ones only (AOI ≤ 100 m).
    // (Wait for the view to settle: right after the teleport it can still hold NPCs near the pad.)
    const allNear = () => {
      let ok = st(a).npcs?.size > 0;
      st(a).npcs?.forEach((n: any) => {
        if (d3([n.x, n.y, n.z], [me(a).x, me(a).y, me(a).z]) >= 105) ok = false;
      });
      return ok;
    };
    await waitFor(allNear, 6000);
  });

  it("an enemy notices, telegraphs, then damages a player who stays in range", async () => {
    const at = nearPad("arcadia", 0, 70);
    const a = await player("standing", "arcadia", at);
    const id = await spawn(a, "hopbit", offset(at, 3, 0, BODIES.arcadia.radius), { level: 1, instant: true });
    let teleAt = 0;
    let sawWindup = false;
    a.onMessage("npcAtk", (m: any) => {
      if (m.id === id && m.a >= 0 && !teleAt) teleAt = Date.now();
    });
    const hp0 = me(a).hp;
    await waitFor(() => {
      const n = st(a).npcs?.get(id);
      if (n && n.anim === NPC_ANIM.WINDUP && n.target === a.sessionId) sawWindup = true;
      return me(a).hp < hp0;
    }, 6000);
    const hitAt = Date.now();
    expect(teleAt).toBeGreaterThan(0);
    expect(sawWindup).toBe(true);
    // Damage lands only after the 0.5 s telegraph (less a little network slack).
    expect(hitAt - teleAt).toBeGreaterThanOrEqual(380);
  });

  it("an enemy doesn't damage a player who dodges out before the telegraph ends", async () => {
    const at = nearPad("arcadia", 0, 70);
    const a = await player("dodger", "arcadia", at);
    const id = await spawn(a, "hopbit", offset(at, 3, 0, BODIES.arcadia.radius), { level: 1, instant: true });
    let tele: any = null;
    a.onMessage("npcAtk", (m: any) => {
      if (m.id === id && m.a >= 0 && !tele) {
        tele = m;
        a.send("admin", { cmd: "teleport", args: { x: far[0], y: far[1], z: far[2] } });
      }
    });
    const far = offset(at, -14, 6, BODIES.arcadia.radius);
    const hp0 = me(a).hp;
    await waitFor(() => tele !== null, 6000);
    await sleep(tele.ms + 300);
    expect(me(a).hp).toBe(hp0);
  });

  it("leash: a chasing enemy that strays too far from home returns and heals", async () => {
    NPC_TUNING.leash = 10;
    const at = nearPad("arcadia", 0, 70);
    const a = await player("kiter", "arcadia", at);
    const home = offset(at, 5, 0, BODIES.arcadia.radius);
    const id = await spawn(a, "hopbit", home, { level: 3, instant: true });
    a.send("npc", { cmd: "hurt", id, amount: 5, as: a.sessionId });
    await waitFor(() => !!((st(a).npcs?.get(id)?.flags ?? 0) & NF.AGGRO), 3000);
    place(a, offset(at, -32, 0, BODIES.arcadia.radius));
    await waitFor(() => !!((st(a).npcs?.get(id)?.flags ?? 0) & NF.EVADING), 8000);
    await waitFor(() => {
      const n = st(a).npcs?.get(id);
      return !!n && !(n.flags & NF.EVADING);
    }, 8000);
    const n = await npcOf(a, id);
    expect(flat([n.x, n.y, n.z], [n.hx, n.hy, n.hz])).toBeLessThan(2.5);
    expect(n.hp).toBe(n.maxHp);
  });

  it("killing an enemy pays XP to everyone with ≥ 20% damage or the killing blow, coins to the top dealer", async () => {
    const at = nearPad("arcadia", 0, 70);
    const A = await player("alpha", "arcadia", at);
    const B = await player("bravo", "arcadia", offset(at, 0, 4, BODIES.arcadia.radius));
    const C = await player("charlie", "arcadia", offset(at, 0, -4, BODIES.arcadia.radius));
    const id = await spawn(A, "hopbit", offset(at, 20, 0, BODIES.arcadia.radius), { level: 1, instant: true });
    const kills: Record<string, any> = {};
    const you: Record<string, any> = {};
    for (const [k, r] of Object.entries({ A, B, C })) {
      r.onMessage("npcKill", (m: any) => (kills[k] = m));
      r.onMessage("you", (m: any) => (you[k] = m));
    }
    // Hopbit L1: 22 HP. A deals 12 (55%), C 3 (14%), B lands the killing blow.
    A.send("npc", { cmd: "hurt", id, amount: 12, as: A.sessionId });
    C.send("npc", { cmd: "hurt", id, amount: 3, as: C.sessionId });
    await sleep(150);
    B.send("npc", { cmd: "hurt", id, amount: 7, as: B.sessionId });
    await waitFor(() => !!kills.A && !!kills.B, 3000);
    await sleep(300);
    expect(kills.A.xp).toBe(15);
    expect(kills.A.coins).toBe(3);
    expect(kills.B.xp).toBe(15);
    expect(kills.B.coins).toBe(0);
    expect(kills.C).toBeUndefined();
    expect(you.A.coins).toBe(3);
    expect(you.A.xp).toBe(15);
    expect(you.B.xp).toBe(15);
    expect(you.C?.xp ?? 0).toBe(0);
    // The corpse dissolves (DEAD flag) and leaves the room state.
    await waitFor(() => !st(A).npcs?.has(id), 3000);
  });

  it("weapon fire hits an NPC's hitbox", async () => {
    const at = nearPad("arcadia", 0, 70);
    const a = await player("gunner", "arcadia", at);
    const target = offset(at, 10, 0, BODIES.arcadia.radius);
    const id = await spawn(a, "woolback", target, { level: 1, instant: true });
    await waitFor(() => !!st(a).npcs?.get(id));
    const n = st(a).npcs.get(id);
    const s = me(a);
    const l = Math.hypot(s.x, s.y, s.z);
    const o = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
    const nl = Math.hypot(n.x, n.y, n.z);
    const aim = [n.x + (n.x / nl) * 0.6, n.y + (n.y / nl) * 0.6, n.z + (n.z / nl) * 0.6];
    const dv = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
    const dl = Math.hypot(dv[0]!, dv[1]!, dv[2]!);
    const hp0 = n.hp;
    a.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: dv[0]! / dl, dy: dv[1]! / dl, dz: dv[2]! / dl, t: Date.now() });
    await waitFor(() => (st(a).npcs.get(id)?.hp ?? hp0) < hp0, 3000);
  });

  it("Woolbacks flee when hit", async () => {
    const at = nearPad("arcadia", 0, 70);
    const a = await player("shepherd", "arcadia", at);
    const id = await spawn(a, "woolback", offset(at, 3, 0, BODIES.arcadia.radius), { level: 1, instant: true });
    await waitFor(() => !!st(a).npcs?.get(id));
    a.send("npc", { cmd: "hurt", id, amount: 4, as: a.sessionId });
    let fled = false;
    await waitFor(() => {
      const n = st(a).npcs.get(id);
      if (n.anim === NPC_ANIM.FLEE) fled = true;
      return flat([n.x, n.y, n.z], [me(a).x, me(a).y, me(a).z]) > 10;
    }, 5000);
    expect(fled).toBe(true);
  });
});

describe("bosses (seam 1)", () => {
  const arcadia = () => bossArena(createTerrain("arcadia"))!;
  const hollow = () => bossArena(createTerrain("hollowmere"))!;

  async function bossUp(r: Room) {
    let info: any = null;
    await waitFor(() => {
      void bossInfo(r).then((i) => (info = i));
      return info?.status === "alive" && info.engaged;
    }, 6000);
    // Materialising (1 s): no damage either way.
    await waitFor(() => !!st(r).npcs?.get(info.id) && !(st(r).npcs.get(info.id).flags & NF.SPAWNING), 3000);
    return info;
  }

  it("Tidewrath: one player on one Tide Stone can't moor it (armour + regen); two on both stones open the weak window", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = [];
    const ar = arcadia();
    const A = await player("stone-a", "arcadia", ar.plates[0]! as V, 8);
    const boss = await bossUp(A);
    expect(boss.maxHp).toBe(12_000);
    let windows = 0;
    A.onMessage("boss", (m: any) => m.type === "window" && m.ms > 0 && windows++);
    // Solo on one stone: no Moor; hits are cut to 20%; the anti-solo regen climbs back.
    A.send("npc", { cmd: "hurt", id: boss.id, amount: 1000, as: A.sessionId });
    await waitFor(() => st(A).npcs.get(boss.id)?.hp === 12_000 - 200, 2000);
    NPC_TUNING.regenAfterMs = 0; // (45 s in play) no window lately → +0.25% max HP/s
    await sleep(3600);
    expect(windows).toBe(0);
    expect(st(A).npcs.get(boss.id).flags & NF.WEAK_OPEN).toBe(0);
    expect(st(A).npcs.get(boss.id).hp).toBeGreaterThan(12_000 - 200);
    // A second body on the other stone: both held 3 s → Moored, full damage.
    const B = await player("stone-b", "arcadia", ar.plates[1]! as V, 8);
    await waitFor(() => !!((st(A).npcs.get(boss.id)?.flags ?? 0) & NF.WEAK_OPEN), 6000);
    expect(windows).toBe(1);
    const hp = st(A).npcs.get(boss.id).hp;
    B.send("npc", { cmd: "hurt", id: boss.id, amount: 1000, as: B.sessionId });
    await waitFor(() => st(A).npcs.get(boss.id).hp <= hp - 1000 + 40, 2000);
  }, 30_000);

  it("boss HP scales with the players inside the arena and keeps its percentage", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = [];
    const ar = arcadia();
    const R = BODIES.arcadia.radius;
    const A = await player("p1", "arcadia", ar.centre as V, 8);
    const boss = await bossUp(A);
    await player("p2", "arcadia", offset(ar.centre, 3, 0, R), 8);
    const C = await player("p3", "arcadia", offset(ar.centre, -3, 0, R), 8);
    await waitFor(() => st(A).npcs.get(boss.id)?.maxHp === 16_200, 3000);
    A.send("npc", { cmd: "hurt", id: boss.id, amount: 8100 / 0.2, as: A.sessionId }); // half of 16,200 after armour
    await waitFor(() => st(A).npcs.get(boss.id).hp === 8100, 2000);
    place(C, offset(ar.centre, 0, 120, R));
    await waitFor(() => st(A).npcs.get(boss.id)?.maxHp === 12_000, 3000);
    expect(st(A).npcs.get(boss.id).hp).toBe(6000);
  }, 30_000);

  it("Hollow King: Royal Judgement kills a lone player", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = ["royal_judgement"];
    NPC_TUNING.firstMechanicMs = 300;
    const ar = hollow();
    const A = await player("lone", "hollowmere", ar.centre as V, 14);
    expect(me(A).maxHp).toBe(230);
    let died = false;
    A.onMessage("death", (m: any) => m.victim === A.sessionId && (died = true));
    let circle: any = null;
    A.onMessage("boss", (m: any) => m.type === "mechanic" && m.mech === "royal_judgement" && (circle = m));
    await bossUp(A);
    await waitFor(() => circle !== null, 4000);
    expect(circle.ms).toBe(2000);
    await waitFor(() => died, 4000);
  }, 30_000);

  it("Hollow King: two players sharing the cursed circle both survive (138 each)", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = ["royal_judgement"];
    NPC_TUNING.firstMechanicMs = 300;
    const ar = hollow();
    const R = BODIES.hollowmere.radius;
    const A = await player("duo-a", "hollowmere", ar.centre as V, 14);
    const B = await player("duo-b", "hollowmere", offset(ar.centre, 1, 0, R), 14);
    let end: any = null;
    A.onMessage("boss", (m: any) => m.type === "mechanicEnd" && m.mech === "royal_judgement" && (end = m));
    await bossUp(A);
    await waitFor(() => end !== null, 6000);
    await sleep(150);
    expect(end.engaged).toBe(2);
    expect(me(A).hp).toBe(230 - 138);
    expect(st(A).players.get(B.sessionId).hp).toBe(230 - 138);
    expect(me(A).flags & 32).toBe(0);
  }, 30_000);

  it("The Receiver: a duo soaks Foreclosure together (60% each), then holds both consoles for Asset Freeze", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = ["foreclosure"];
    NPC_TUNING.firstMechanicMs = 200;
    const ar = bossArena(createTerrain("meridian"))!;
    const R = BODIES.meridian.radius;
    const A = await player("duo-1", "meridian", ar.centre as V, 20);
    const B = await player("duo-2", "meridian", offset(ar.centre, 6, 0, R), 20);
    const boss = await bossUp(A);
    expect(boss.maxHp).toBe(30_000);
    let stamp: any = null;
    let end: any = null;
    A.onMessage("boss", (m: any) => {
      if (m.type === "mechanic" && m.mech === "foreclosure") stamp = m;
      if (m.type === "mechanicEnd" && m.mech === "foreclosure") end = m;
    });
    // P1 has no Foreclosure; push it into P2 (below 60%): 13,000 after the 25% armour.
    await sleep(800);
    expect(stamp).toBeNull();
    A.send("npc", { cmd: "hurt", id: boss.id, amount: 13_000 / 0.25, as: A.sessionId });
    await waitFor(() => st(A).npcs.get(boss.id)?.phase === 2, 2000);
    await waitFor(() => stamp !== null, 3000);
    expect(stamp.r).toBe(4.5);
    // Both into the stamp before it lands: 348 split two ways = 174 each (60% of 290).
    const c = stamp.pts as V;
    place(A, c);
    place(B, offset(c, 1, 0, R));
    await waitFor(() => end !== null, 3000);
    await sleep(150);
    expect(end.engaged).toBe(2);
    expect(me(A).hp).toBe(290 - 174);
    expect(st(A).players.get(B.sessionId).hp).toBe(290 - 174);
    // Then both run to the Override Consoles: held 3 s together → the Receiver kneels.
    place(A, ar.plates[0]! as V);
    place(B, ar.plates[1]! as V);
    await waitFor(() => !!((st(A).npcs.get(boss.id)?.flags ?? 0) & NF.WEAK_OPEN), 6000);
  }, 30_000);

  it("a defeated boss pays every contributor and respawns after its timer", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = [];
    NPC_TUNING.bossRespawnMs = 1500;
    const ar = arcadia();
    const A = await player("slayer", "arcadia", ar.centre as V, 8);
    let you: any = null;
    let kill: any = null;
    let defeat = false;
    A.onMessage("you", (m: any) => (you = m));
    A.onMessage("npcKill", (m: any) => (kill = m));
    A.onMessage("boss", (m: any) => m.type === "defeat" && (defeat = true));
    const boss = await bossUp(A);
    A.send("npc", { cmd: "hurt", id: boss.id, amount: 1e7, as: A.sessionId });
    await waitFor(() => defeat && !!kill, 3000);
    expect(kill.xp).toBe(2000);
    expect(kill.coins).toBe(120);
    await waitFor(() => (you?.coins ?? 0) >= 120 && JSON.stringify(you.hotbar.concat(you.backpack)).includes("tonic_large"), 2000);
    expect((await bossInfo(A)).status).toBe("dead");
    let again: any = null;
    await waitFor(() => {
      void bossInfo(A).then((i) => (again = i));
      return again?.status === "alive" && again.id !== boss.id;
    }, 6000);
    expect(again.hp).toBe(again.maxHp);
  }, 30_000);
});



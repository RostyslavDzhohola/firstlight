import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, isSafe, TOWN_GATES } from "@firstlight/shared";
import { STARTERS, WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { flat, me, nearPad, offset, place, spawnNpc, st, type V } from "./npc-bots.ts";

// The ninja starter (HANDOFF 6h): Ember Kunai throws, and the Ember Seal fireball on a held RMB.
let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const NINJA = STARTERS.findIndex((s) => s.id === "ninja");
/** Metres from Arcadia's pad 0 to the duel spot: out of the walled arrival outpost, on open land. */
const BASE = 70;
const SEAL = WEAPON_BY_ID.get("ember_seal")!;
const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** waitFor with a label in the failure message. */
const until = (label: string, cond: () => boolean, ms?: number) => waitFor(cond, ms).catch(() => {
  throw new Error(`timed out waiting for: ${label}`);
});
const pos = (r: Room): V => [me(r).x, me(r).y, me(r).z];

/** A camera ray from the shooter's head at a point `h` metres above `t`. */
function aimAtPoint(shooter: Room, t: readonly number[], h = 1.0) {
  const s = pos(shooter);
  const l = Math.hypot(s[0], s[1], s[2]);
  const o = [s[0] + (s[0] / l) * 1.6, s[1] + (s[1] / l) * 1.6, s[2] + (s[2] / l) * 1.6];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const aim = [t[0]! + (t[0]! / tl) * h, t[1]! + (t[1]! / tl) * h, t[2]! + (t[2]! / tl) * h];
  const d = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}
const aimAt = (shooter: Room, target: Room) => aimAtPoint(shooter, pos(target));

const ready = (r: Room) => {
  const s = me(r);
  return !!s && !(s.flags & PF.SAFE) && !(s.flags & PF.PROTECTED);
};

async function join(name: string, body: string, starter: number) {
  const r = await joinAs(game, name, body, { starter }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}

async function stand(r: Room, at: V) {
  place(r, at);
  // A teleport onto a structure lands beside it; tests aim at actual positions.
  await until(`standing at ${at.map((x) => x.toFixed(1))}`, () => flat(pos(r), at) < 4 && ready(r));
}

/** A ninja and `targets` players `metres` (and `sideways`) down a fixed tangent from Arcadia pad 0. */
async function duel(metres = 12, extra: [number, number][] = []) {
  const a = await join("ninja", "arcadia", NINJA);
  const b = await join("target", "arcadia", 1);
  const others = [];
  for (let i = 0; i < extra.length; i++) others.push(await join(`t${i}`, "arcadia", 1));
  const base = nearPad("arcadia", 0, BASE);
  const R = BODIES.arcadia.radius;
  await stand(a, base);
  await stand(b, offset(base, metres, 0, R));
  for (let i = 0; i < extra.length; i++) await stand(others[i]!, offset(base, extra[i]![0], extra[i]![1], R));
  const denied: string[] = [];
  a.onMessage("denied", (m: { reason: string }) => denied.push(m.reason));
  const hp = (r: Room = b) => st(a).players.get(r.sessionId).hp as number;
  return { a, b, others, denied, hp };
}

async function seal(a: Room, target: { ox: number }, ms = 450) {
  a.send("charge", { on: true });
  await hold(ms);
  a.send("fire", { slot: 0, ...target, t: Date.now(), seal: true });
}

describe("ninja starter: Ember Kunai and Ember Seal", () => {
  it("the ninja starts with the Ember Kunai, and a throw hurts", async () => {
    const { a, b, hp } = await duel();
    expect(STARTERS[NINJA]!.weapon).toBe("kunai");
    const before = hp();
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now() });
    await waitFor(() => hp() < before);
    expect(before - hp()).toBe(WEAPON_BY_ID.get("kunai")!.tiers[0].damage);
  });

  it("the seal needs the 0.4 s hand seal, bursts with splash and burn, then cools down", async () => {
    // A bystander 1.2 m beside the target takes the splash, not the direct hit.
    const { a, b, others, denied, hp } = await duel(12, [[12, 1.2]]);
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now(), seal: true });
    await waitFor(() => denied.includes("not charged"));
    const before = hp();
    await seal(a, aimAt(a, b));
    await waitFor(() => hp() <= before - SEAL.tiers[0].damage);
    await waitFor(() => hp(others[0]) < 100);
    expect(100 - hp(others[0])).toBeLessThan(SEAL.tiers[0].splash!); // falloff, no direct hit
    // The burn keeps ticking after the hit.
    const afterHit = hp();
    await waitFor(() => hp() < afterHit, 4000);
    // Straight away again: the tier cooldown refuses it.
    await seal(a, aimAt(a, b));
    await waitFor(() => denied.includes("cooldown"));
  });

  it("a charge started with another item in hand doesn't cast (no fists-to-kunai seal)", async () => {
    const { a, b, denied, hp } = await duel();
    a.send("equip", { slot: 1 }); // empty slot: fists
    await waitFor(() => me(a).weapon === 0);
    a.send("charge", { on: true });
    await hold(450);
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now(), seal: true }); // auto-equips the kunai
    await waitFor(() => denied.includes("not charged"));
    await hold(800);
    expect(hp()).toBe(100);
  });

  it("the fireball reaches 30 m and no further", async () => {
    const R = BODIES.arcadia.radius;
    const base = nearPad("arcadia", 0, BASE);
    // Two ninjas side by side, each with a target down its own line: 28 m (inside) and 32.5 m (outside).
    const near = await join("ninja_n", "arcadia", NINJA);
    const far = await join("ninja_f", "arcadia", NINJA);
    const tn = await join("t_near", "arcadia", 1);
    const tf = await join("t_far", "arcadia", 1);
    await stand(near, base);
    await stand(far, offset(base, 0, 10, R));
    const nearAt = offset(base, SEAL.range - 2, 0, R);
    const farAt = offset(base, SEAL.range + 2.5, 10, R);
    await stand(tn, nearAt);
    await stand(tf, farAt);
    const hpOf = (r: Room) => st(near).players.get(r.sessionId).hp as number;
    await seal(far, aimAtPoint(far, pos(tf), 1.3));
    await seal(near, aimAtPoint(near, pos(tn), 1.3));
    await until("the near target hit", () => hpOf(tn) < 100);
    await hold(1500); // the far bolt had time to fly 36 m and more
    expect(hpOf(tf)).toBe(100);
  });

  it("the seal is refused the moment its caster steps into a pad's safe ring", async () => {
    const a = await join("ninja", "arcadia", NINJA);
    const out = nearPad("arcadia", 0, 13);
    const inside = nearPad("arcadia", 0, 11);
    expect(isSafe(BODIES.arcadia, ...out)).toBe(false);
    expect(isSafe(BODIES.arcadia, ...inside)).toBe(true);
    await stand(a, out);
    const denied: string[] = [];
    a.onMessage("denied", (m: { reason: string }) => denied.push(m.reason));
    a.send("charge", { on: true });
    await hold(450);
    // Teleport in and release at once, before the tick refreshes the SAFE flag.
    a.send("admin", { cmd: "teleport", args: { x: inside[0], y: inside[1], z: inside[2] } });
    a.send("fire", { slot: 0, ...aimAtPoint(a, nearPad("arcadia", 0, 30)), t: Date.now(), seal: true });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toBe("safe zone");
  });

  it("the seal is refused the moment its caster walks through the Portus town gate", async () => {
    const a = await join("ninja", "portus", NINJA);
    const R = BODIES.portus.radius;
    // Along the line from the town centre out through the east gate: the last safe point and the
    // first wild one either side of the border.
    const g = TOWN_GATES[0]!;
    const along = (k: number): V => {
      const c = [0, R, 0];
      const v = [c[0]! + (g[0] * R - c[0]!) * k, c[1]! + (g[1] * R - c[1]!) * k, c[2]! + (g[2] * R - c[2]!) * k];
      const l = Math.hypot(v[0]!, v[1]!, v[2]!);
      return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
    };
    let inside: V | null = null;
    let outside: V | null = null;
    for (let k = 0.8; k < 1.6 && !outside; k += 0.02) {
      const p = along(k);
      if (isSafe(BODIES.portus, ...p)) inside = p;
      else if (inside) outside = along(k + 0.12);
    }
    expect(inside && outside).toBeTruthy();
    await stand(a, outside!);
    a.send("admin", { cmd: "unprotect" });
    const denied: string[] = [];
    a.onMessage("denied", (m: { reason: string }) => denied.push(m.reason));
    a.send("charge", { on: true });
    await hold(450);
    a.send("admin", { cmd: "teleport", args: { x: inside![0], y: inside![1], z: inside![2] } });
    a.send("fire", { slot: 0, ...aimAtPoint(a, outside!), t: Date.now(), seal: true });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toBe("safe zone");
  });

  it("burns an NPC after the blast", async () => {
    const a = await join("ninja", "arcadia", NINJA);
    const base = nearPad("arcadia", 0, BASE);
    await stand(a, base);
    const at = offset(base, 10, 0, BODIES.arcadia.radius);
    const id = await spawnNpc(a, "bramblehorn", at, { instant: true, roam: 0 });
    await until("the NPC in view", () => !!st(a).npcs?.get(id));
    const npc = () => st(a).npcs.get(id);
    const before = npc().hp;
    await seal(a, aimAtPoint(a, [npc().x, npc().y, npc().z], 2.5)); // a 6 m beast: aim at its chest
    await until("the NPC hit", () => npc().hp < before);
    const afterHit = npc().hp;
    await until("the NPC burning", () => npc().hp < afterHit, 4000);
  });

  it("the hidden Ember Seal item can never be fired on its own", async () => {
    const { a, b, denied } = await duel();
    let you: any = null;
    a.onMessage("you", (m) => (you = m));
    a.send("admin", { cmd: "give", args: { id: "ember_seal" } });
    await waitFor(() => you?.hotbar?.[1]?.id === "ember_seal");
    a.send("fire", { slot: 1, ...aimAt(a, b), t: Date.now() });
    await waitFor(() => denied.includes("not a weapon"));
  });
});

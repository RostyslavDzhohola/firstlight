import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { STARTERS, WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

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
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);

/** A point `metres` from Arcadia's main pad along a fixed tangent (outside the safe ring). */
function awayFromPad(metres: number): [number, number, number] {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  let t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  t = t.map((v) => v / tl);
  const v = [d[0] + (t[0]! * metres) / R, d[1] + (t[1]! * metres) / R, d[2] + (t[2]! * metres) / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

function place(r: Room, p: [number, number, number]) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
}

function aimAt(shooter: Room, target: Room) {
  const s = me(shooter), t = st(shooter).players.get(target.sessionId);
  const l = Math.hypot(s.x, s.y, s.z);
  const o = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
  const tl = Math.hypot(t.x, t.y, t.z);
  const aim = [t.x + (t.x / tl) * 1.0, t.y + (t.y / tl) * 1.0, t.z + (t.z / tl) * 1.0];
  const d = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}

const ready = (r: Room) => {
  const s = me(r);
  return !!s && !(s.flags & PF.SAFE) && !(s.flags & PF.PROTECTED);
};

async function duel() {
  const a = await joinAs(game, "ninja", "arcadia", { starter: NINJA }, "admin");
  const b = await joinAs(game, "target", "arcadia", { starter: 1 }, "admin");
  rooms.push(a, b);
  await waitFor(() => st(a).players?.size === 2 && st(b).players?.size === 2);
  place(a, awayFromPad(40));
  place(b, awayFromPad(52));
  await waitFor(() => Math.abs(Math.hypot(me(a).x - me(b).x, me(a).y - me(b).y, me(a).z - me(b).z) - 12) < 1.5);
  await waitFor(() => ready(a) && ready(b));
  const denied: string[] = [];
  a.onMessage("denied", (m: { reason: string }) => denied.push(m.reason));
  return { a, b, denied, hp: () => st(a).players.get(b.sessionId).hp as number };
}

const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ninja starter: Ember Kunai and Ember Seal", () => {
  it("the ninja starts with the Ember Kunai, and a throw hurts", async () => {
    const { a, hp } = await duel();
    expect(STARTERS[NINJA]!.weapon).toBe("kunai");
    const before = hp();
    a.send("fire", { slot: 0, ...aimAt(a, rooms[1]!), t: Date.now() });
    await waitFor(() => hp() < before);
    expect(before - hp()).toBe(WEAPON_BY_ID.get("kunai")!.tiers[0].damage);
  });

  it("the seal needs the 0.4 s hand seal, bursts with splash and burn, then cools down", async () => {
    const { a, b, denied, hp } = await duel();
    // Released without a held seal: refused, nothing flies.
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now(), seal: true });
    await waitFor(() => denied.includes("not charged"));
    const before = hp();
    a.send("charge", { on: true });
    await hold(450);
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now(), seal: true });
    const seal = WEAPON_BY_ID.get("ember_seal")!.tiers[0];
    await waitFor(() => hp() <= before - seal.damage);
    // The burn keeps ticking after the hit.
    const afterHit = hp();
    await waitFor(() => hp() < afterHit, 4000);
    // Straight away again: the tier cooldown refuses it.
    a.send("charge", { on: true });
    await hold(450);
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now(), seal: true });
    await waitFor(() => denied.includes("cooldown"));
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

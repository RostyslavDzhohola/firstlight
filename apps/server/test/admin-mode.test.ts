// Admin mode (D-admin-1) on the real server path: the switches only work for admin accounts, the
// movement check accepts admin flight and double speed only with the switch on, god mode takes no
// damage but changes nothing about who the admin can hurt, and max level / every item / back to
// normal round-trip the character (also across a rejoin).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";
import { LEVEL_CAP, maxHp } from "@firstlight/shared/content/progression";
import { motionFields, moveLimits } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { adminItems } from "../src/world/adminMode.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, harness, me, offPad, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

type V = [number, number, number];
const up = (p: readonly number[]): V => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return [p[0]! / l, p[1]! / l, p[2]! / l];
};
const add = (a: readonly number[], b: readonly number[], k: number): V => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
/** A unit tangent at `p` (any horizontal direction). */
const tangent = (p: readonly number[]): V => {
  const u = up(p);
  const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * u[0] + ref[1]! * u[1] + ref[2]! * u[2];
  return up([ref[0]! - k * u[0], ref[1]! - k * u[1], ref[2]! - k * u[2]]);
};

let seq = 1000;
/** Moves like a client: one input packet per 50 ms along `path`; returns the corrections received. */
async function drive(b: Bot, path: readonly V[]): Promise<number> {
  const before = b.count("correct");
  for (const p of path) {
    b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: 1, fy: 0, fz: 0, anim: 2, t: Date.now() });
    await sleep(50);
  }
  await sleep(200);
  return b.count("correct") - before;
}

const mode = (b: Bot, args: Record<string, unknown>) => b.send("admin", { cmd: "adminmode", args });

/** Out on Arcadia, away from the pad ring, unprotected. */
async function outside(b: Bot): Promise<V> {
  const at = offPad("arcadia", 0, 40);
  await tpAndWait(b, at);
  b.send("admin", { cmd: "unprotect" });
  await sleep(200);
  return [me(b).x, me(b).y, me(b).z];
}

/** Up `h` metres at `climb` m/s, hover a second, sideways and back at `side` m/s, then straight down. */
function flight(start: V, h: number, climb: number, side: number): V[] {
  const u = up(start);
  const t = tangent(start);
  const path: V[] = [];
  for (let y = climb / 20; y <= h; y += climb / 20) path.push(add(start, u, y));
  const top = add(start, u, h);
  for (let i = 0; i < 20; i++) path.push(top);
  for (let x = side / 20; x <= 6; x += side / 20) path.push(add(top, t, x));
  for (let x = 6; x >= 0; x -= side / 20) path.push(add(top, t, x));
  for (let y = h; y >= 0; y -= climb / 20) path.push(add(start, u, y));
  return path;
}

/** Back and forth along a 4 m line at `speed` m/s for `seconds` (no props in the way, the charge is the same). */
function shuttle(start: V, speed: number, seconds: number): V[] {
  const t = tangent(start);
  const path: V[] = [];
  let x = 0, dir = 1;
  for (let i = 0; i < seconds * 20; i++) {
    x += (dir * speed) / 20;
    if (x > 4 || x < 0) {
      dir = -dir;
      x += (2 * dir * speed) / 20;
    }
    path.push(add(start, t, x));
  }
  return path;
}

describe("admin mode switches", () => {
  it("only admins get them: a player's admin command is dropped and `you` has no admin mode", async () => {
    const p = await bot("player_am", "arcadia", "");
    expect(p.you.adminMode).toBeUndefined();
    mode(p, { fly: true, god: true, speed: true });
    await sleep(400);
    expect(p.you.adminMode).toBeUndefined();
    expect(serverRoom(p).actors.get(p.id)!.adminMode).toBeUndefined();
    const a = await bot("admin_am", "arcadia");
    expect(a.you.adminMode).toEqual({ fly: false, god: false, speed: false, backup: false });
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
  });

  it("movement limits ignore switches on a non-admin actor (even if one were set)", () => {
    const actor = { identity: { admin: false }, adminMode: { fly: true, god: true, speed: true }, ...motionFields(BODIES.arcadia.radius, 0) } as unknown as PlayerActor;
    expect(moveLimits(actor, 0)).not.toHaveProperty("fly");
    expect(moveLimits(actor, 0)).not.toHaveProperty("boost");
    actor.identity.admin = true;
    expect(moveLimits(actor, 0)).toMatchObject({ fly: true, boost: ADMIN_MODE.speedMult });
  });
});

describe("admin flight and speed, as the movement check sees them", () => {
  it("an admin with Fly on climbs 12 m, hovers, flies and lands: no correction, no fall damage", async () => {
    const a = await bot("flyer", "arcadia");
    const start = await outside(a);
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
    const hp = me(a).hp;
    expect(await drive(a, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBe(0);
    expect(me(a).hp).toBe(hp);
  });

  it("the same flight is refused without the switch, and for a player", async () => {
    const a = await bot("grounded_admin", "arcadia");
    const start = await outside(a);
    expect(await drive(a, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBeGreaterThan(0);
    const p = await bot("would_fly", "arcadia", "");
    const pStart = await (async () => {
      const at = offPad("arcadia", 0, 46);
      p.send("admin", { cmd: "teleport", args: { x: at[0], y: at[1], z: at[2] } }); // dropped: not an admin
      await sleep(300);
      return [me(p).x, me(p).y, me(p).z] as V;
    })();
    mode(p, { fly: true });
    expect(await drive(p, flight(pStart, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBeGreaterThan(0);
  });

  it("Fly switched off mid-air: the body falls, and the fall hurts from there", async () => {
    const a = await bot("dropper", "arcadia");
    const start = await outside(a);
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
    const u = up(start);
    const climb: V[] = [];
    for (let y = 0.4; y <= 14; y += 0.4) climb.push(add(start, u, y));
    expect(await drive(a, climb)).toBe(0);
    const hp = me(a).hp;
    mode(a, { fly: false });
    await until("fly off", () => a.you.adminMode?.fly === false);
    // Silent client: the server's own gravity brings it down and charges the fall.
    await waitFor(() => Math.hypot(me(a).x, me(a).y, me(a).z) < Math.hypot(...start) + 1, 6000);
    await until("fall damage", () => me(a).hp < hp);
  });

  it("Speed ×2: 16 m/s for 2 s passes for an admin with the switch, not without it or for a player", async () => {
    const a = await bot("sprinter", "arcadia");
    const start = await outside(a);
    expect(await drive(a, shuttle(start, 16, 2))).toBeGreaterThan(0); // switch off: corrected
    mode(a, { speed: true });
    await until("speed on", () => a.you.adminMode?.speed === true);
    await sleep(400); // the bank refills
    expect(await drive(a, shuttle(start, 16, 2))).toBe(0);
    const p = await bot("would_sprint", "arcadia", "");
    mode(p, { speed: true });
    await sleep(300);
    expect(await drive(p, shuttle([me(p).x, me(p).y, me(p).z], 16, 2))).toBeGreaterThan(0);
  });
});

describe("god mode", () => {
  it("an admin with God on takes no damage; off, it does", async () => {
    const a = await bot("immortal", "arcadia");
    await outside(a);
    mode(a, { god: true });
    await until("god on", () => a.you.adminMode?.god === true);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 500 } });
    await sleep(400);
    expect(me(a).hp).toBe(me(a).maxHp);
    expect(a.count("death")).toBe(0);
    mode(a, { god: false });
    await until("god off", () => a.you.adminMode?.god === false);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 30 } });
    await until("hurt", () => me(a).hp < me(a).maxHp);
  });

  it("God doesn't let the admin hurt a player in a safe zone", async () => {
    const a = await bot("god_shooter", "arcadia", "admin", { starter: 3 }); // carbine
    const p = await bot("on_the_pad", "arcadia", "");
    await outside(a);
    mode(a, { god: true });
    await until("god on", () => a.you.adminMode?.god === true);
    await waitFor(() => (me(p).flags & 1) !== 0); // the player stands in the arrival ring: safe
    const hp = me(p).hp;
    const o = add([me(a).x, me(a).y, me(a).z], up([me(a).x, me(a).y, me(a).z]), 1.6);
    const t = add([me(p).x, me(p).y, me(p).z], up([me(p).x, me(p).y, me(p).z]), 1);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    for (let i = 0; i < 3; i++) {
      a.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l, t: Date.now() });
      await sleep(300);
    }
    expect(me(p).hp).toBe(hp);
  });
});

describe("max level, every item, back to normal", () => {
  it("round-trips the character, and the saved character survives a rejoin", async () => {
    const a = await bot("tester", "portus", "admin", { starter: 0 });
    const before = { level: a.you.level, hotbar: JSON.stringify(a.you.hotbar), backpack: JSON.stringify(a.you.backpack) };
    mode(a, { action: "maxlevel" });
    await until("max level", () => me(a).level === LEVEL_CAP && me(a).hp === maxHp(LEVEL_CAP));
    mode(a, { action: "giveall" });
    const all = adminItems().map((w) => w.id);
    await until("every item", () => [...a.you.hotbar, ...a.you.backpack].filter(Boolean).length === Math.min(all.length, 20));
    const have = [...a.you.hotbar, ...a.you.backpack].filter(Boolean).map((x: { id: string; tier: number }) => x);
    expect(have.map((x) => x.id)).toEqual(all.slice(0, 20));
    expect(have.find((x) => x.id === "carbine")?.tier).toBe(3); // max level: the top tier
    // Any item at any tier into the hand; a cosmetic is worn.
    mode(a, { action: "hand", id: "stillshot", tier: 2 });
    await until("in hand", () => a.you.hotbar[a.you.selected]?.id === "stillshot");
    expect(a.you.hotbar[a.you.selected].tier).toBe(2);
    mode(a, { action: "hand", id: "fox_mask" });
    await until("worn", () => a.you.worn?.mask === "fox_mask");
    expect(a.you.adminMode.backup).toBe(true);
    // Rejoin: the backup is kept with the character.
    await safeLeave(a.room);
    harness.rooms.splice(harness.rooms.indexOf(a.room), 1);
    const b = await bot("tester", "portus");
    expect(b.you.adminMode.backup).toBe(true);
    mode(b, { action: "normal", fly: true }); // "normal" wins: everything off
    await until("normal", () => b.you.adminMode?.backup === false && me(b).level === before.level);
    expect(b.you.adminMode).toEqual({ fly: false, god: false, speed: false, backup: false });
    expect(JSON.stringify(b.you.hotbar)).toBe(before.hotbar);
    expect(JSON.stringify(b.you.backpack)).toBe(before.backpack);
    expect(b.you.worn ?? {}).toEqual({});
  });
});

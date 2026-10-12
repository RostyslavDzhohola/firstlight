// Horses (seam 1): SDK bots against the real in-process server. The whistle item and the shop, where
// the whistle works, mounted movement validation, no weapons from the saddle, and every way the
// horse leaves (death with the whistle in the pile, travel, logout, idle, lost whistle).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, isSafe, portalSpots, type BodyId } from "@firstlight/shared";
import { HORSE, HORSE_WHISTLE, tooDeepToRide } from "@firstlight/shared/content/horse";
import { PF } from "@firstlight/shared/net/schema";
import { env } from "../src/env.ts";
import { HorseSystem } from "../src/world/horses/HorseSystem.ts";
import { applyMoveEffect } from "../src/world/npc/effects.ts";
import { pileStore } from "../src/world/piles.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, harness, invIds, me, objAt, offPad, padAt, serverRoom, sleep, terrain, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

type V3 = [number, number, number];
const BODY: BodyId = "arcadia";
const horses = (b: Bot) => (b.room.state as any).horses as Map<string, any>;
const mounted = (b: Bot) => !!(me(b).flags & PF.MOUNTED);
const horseSystem = (b: Bot) => serverRoom(b).systems.find((s): s is HorseSystem => s instanceof HorseSystem)!;

/** A level-1 admin bot standing 40 m off Arcadia's main pad (outside the safe ring) with a whistle. */
async function rider(userId: string, whistle = true, at: V3 = offPad(BODY, 0, 40)): Promise<Bot> {
  const b = await bot(userId, BODY, "admin", { starter: 3 }); // Unit 7: the carbine in slot 0
  await tpAndWait(b, at);
  b.send("admin", { cmd: "unprotect" });
  if (whistle) {
    b.send("admin", { cmd: "give", args: { id: HORSE_WHISTLE } });
    await until("whistle in the bags", () => invIds(b).includes(HORSE_WHISTLE));
  }
  return b;
}

async function summonAndMount(b: Bot) {
  b.send("horse", { action: "whistle" });
  await until("horse summoned", () => horses(b).has(b.id));
  b.send("horse", { action: "ride" });
  await until("mounted", () => mounted(b));
}

/** Unit tangent at `p` along which the ground stays dry (no horse-deep water) for `metres`. */
function dryBearing(p: V3, metres: number): V3 {
  const def = BODIES[BODY];
  const t = terrain(BODY);
  const l = Math.hypot(...p);
  const up: V3 = [p[0] / l, p[1] / l, p[2] / l];
  const a: V3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = a[0] * up[0] + a[1] * up[1] + a[2] * up[2];
  const e1 = norm([a[0] - k * up[0], a[1] - k * up[1], a[2] - k * up[2]]);
  const e2 = norm([up[1] * e1[2] - up[2] * e1[1], up[2] * e1[0] - up[0] * e1[2], up[0] * e1[1] - up[1] * e1[0]]);
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2;
    const d = norm([e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang), e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang), e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)]);
    let dry = true;
    for (let s = 2; s <= metres && dry; s += 2) {
      const q = norm([up[0] * def.radius + d[0] * s, up[1] * def.radius + d[1] * s, up[2] * def.radius + d[2] * s]);
      dry = !tooDeepToRide(t.groundHeight(q[0], q[1], q[2]), def.waterLevel + 0.5);
    }
    if (dry) return d;
  }
  throw new Error("no dry bearing");
}

function norm(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The nearest dry ground point outside every safe ring from `p` (2 m past the ring's edge). */
function outsideSafe(p: V3): V3 {
  const def = BODIES[BODY];
  const t = terrain(BODY);
  const up = norm(p);
  const a: V3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = a[0] * up[0] + a[1] * up[1] + a[2] * up[2];
  const e1 = norm([a[0] - k * up[0], a[1] - k * up[1], a[2] - k * up[2]]);
  const e2 = norm([up[1] * e1[2] - up[2] * e1[1], up[2] * e1[0] - up[0] * e1[2], up[0] * e1[1] - up[1] * e1[0]]);
  const at = (ang: number, m: number): V3 => {
    const d = norm([up[0] * def.radius + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * m, up[1] * def.radius + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * m, up[2] * def.radius + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * m]);
    const r = def.radius + t.groundHeight(d[0], d[1], d[2]);
    return [d[0] * r, d[1] * r, d[2] * r];
  };
  for (let m = 4; m <= 40; m++) {
    for (let i = 0; i < 16; i++) {
      const q = at((i / 16) * Math.PI * 2, m);
      const g = Math.hypot(...q) - def.radius;
      if (!isSafe(def, ...q) && !tooDeepToRide(g, def.waterLevel + 0.5)) return at((i / 16) * Math.PI * 2, m + 2);
    }
  }
  throw new Error("no unsafe ground near the portal");
}

/** Ride along the ground toward `target` at `speed` m/s (20 Hz inputs) until within `stop` metres. */
async function rideToward(b: Bot, target: V3, speed: number, stop: number) {
  const def = BODIES[BODY];
  const t = terrain(BODY);
  let pos: V3 = [me(b).x, me(b).y, me(b).z];
  let seq = (me(b).seq ?? 0) + 1000;
  for (let i = 0; i < 400 && Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]) > stop; i++) {
    const up = norm(pos);
    const d0: V3 = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
    const k = d0[0] * up[0] + d0[1] * up[1] + d0[2] * up[2];
    const dir = norm([d0[0] - k * up[0], d0[1] - k * up[1], d0[2] - k * up[2]]);
    const n = norm([pos[0] + dir[0] * speed * 0.05, pos[1] + dir[1] * speed * 0.05, pos[2] + dir[2] * speed * 0.05]);
    const r = def.radius + t.groundHeight(n[0], n[1], n[2]);
    pos = [n[0] * r, n[1] * r, n[2] * r];
    b.send("input", { seq: ++seq, x: pos[0], y: pos[1], z: pos[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 3, t: Date.now() });
    await sleep(50);
  }
}

/**
 * Move along the ground at `speed` m/s for `seconds`, sending 20 Hz inputs like the client.
 * Returns the server's corrections and how far the server let the player get.
 */
async function run(b: Bot, speed: number, seconds: number): Promise<{ corrections: number; moved: number }> {
  const def = BODIES[BODY];
  const t = terrain(BODY);
  const s0 = { x: me(b).x, y: me(b).y, z: me(b).z, seq: me(b).seq }; // copy: the schema object is live
  let pos: V3 = [s0.x, s0.y, s0.z];
  let dir = dryBearing(pos, speed * seconds + 10);
  let seq = (s0.seq ?? 0) + 1000; // 0 is a schema default and never sent
  const before = b.count("correct");
  for (let i = 0; i < seconds * 20; i++) {
    const up = norm(pos);
    const k = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2];
    dir = norm([dir[0] - k * up[0], dir[1] - k * up[1], dir[2] - k * up[2]]);
    const n = norm([pos[0] + dir[0] * speed * 0.05, pos[1] + dir[1] * speed * 0.05, pos[2] + dir[2] * speed * 0.05]);
    const r = def.radius + t.groundHeight(n[0], n[1], n[2]);
    pos = [n[0] * r, n[1] * r, n[2] * r];
    b.send("input", { seq: ++seq, x: pos[0], y: pos[1], z: pos[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 3, t: Date.now() });
    await sleep(50);
  }
  await sleep(200);
  const s1 = me(b);
  return { corrections: b.count("correct") - before, moved: Math.hypot(s1.x - s0.x, s1.y - s0.y, s1.z - s0.z) };
}

describe("the Horse Whistle", () => {
  it("is sold at the Portus Exchange for 1,500 coins, and Portus (all safe) refuses the whistle", async () => {
    const b = await bot("buyer", "portus");
    await tpAndWait(b, objAt("juno_vale"));
    b.send("admin", { cmd: "coins", args: { amount: 1499 } });
    await until("coins", () => b.you.coins === 1499);
    b.send("buy", { itemId: HORSE_WHISTLE });
    await until("refused", () => b.last("shop")?.ok === false);
    expect(b.last("shop").reason).toBe("coins");
    b.send("admin", { cmd: "coins", args: { amount: 1 } });
    await until("coins", () => b.you.coins === 1500);
    b.send("buy", { itemId: HORSE_WHISTLE });
    await until("bought", () => invIds(b).includes(HORSE_WHISTLE));
    expect(b.you.coins).toBe(0);
    b.send("horse", { action: "whistle" });
    await until("denied", () => b.last("denied")?.action === "horse");
    expect(b.last("denied").reason).toBe("safe zone");
    expect(horses(b).size).toBe(0);
  });

  it("can't be used in a pad's safe ring, or outside it without the whistle", async () => {
    const b = await rider("nowhistle", false);
    b.send("horse", { action: "whistle" });
    await until("denied", () => b.last("denied")?.action === "horse");
    expect(b.last("denied").reason).toBe("no whistle");
    expect(b.toasts.at(-1)).toContain("Horse Whistle");

    b.send("admin", { cmd: "give", args: { id: HORSE_WHISTLE } });
    await until("whistle", () => invIds(b).includes(HORSE_WHISTLE));
    await tpAndWait(b, padAt(BODY, 0));
    b.send("horse", { action: "whistle" });
    await until("denied in the ring", () => b.count("denied") >= 2);
    expect(b.last("denied").reason).toBe("safe zone");
    await sleep(200);
    expect(horses(b).size).toBe(0);
  });
});

describe("the horses flag (FEATURE_HORSES)", () => {
  it("on by default: clients are told through you.horses", async () => {
    const b = await rider("flagged", false);
    await until("you", () => b.you?.horses === true);
  });

  it("off: no horse system, the whistle isn't sold, and H is refused without dropping the client", async () => {
    env.horses = false;
    try {
      const b = await bot("nohorses", "portus");
      await tpAndWait(b, objAt("juno_vale"));
      b.send("admin", { cmd: "coins", args: { amount: 5000 } });
      await until("coins", () => b.you.coins === 5000);
      expect(b.you.horses).toBeUndefined();
      expect(serverRoom(b).systems.some((s) => s instanceof HorseSystem)).toBe(false);
      b.send("buy", { itemId: HORSE_WHISTLE });
      await until("refused", () => b.last("shop")?.ok === false);
      expect(b.last("shop").reason).toBe("not sold");

      const r = await bot("nohorses2", BODY);
      await tpAndWait(r, offPad(BODY, 0, 40));
      r.send("admin", { cmd: "give", args: { id: HORSE_WHISTLE } }); // an old whistle still in the bags
      await until("whistle", () => invIds(r).includes(HORSE_WHISTLE));
      r.send("horse", { action: "whistle" });
      await until("denied", () => r.last("denied")?.action === "horse");
      expect(r.last("denied").reason).toBe("off");
      await sleep(150);
      expect(horses(r).size).toBe(0);
      expect(r.room.connection.isOpen).toBe(true);
    } finally {
      env.horses = true;
    }
  });
});

describe("riding", () => {
  it("summons one horse beside you; mounted you may move at 14 m/s, on foot the same speed is corrected", async () => {
    const b = await rider("jockey");
    b.send("horse", { action: "whistle" });
    await until("horse", () => horses(b).has(b.id));
    const h = horses(b).get(b.id);
    const p = me(b);
    const d = Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(HORSE.summonDistance + 1);
    expect(!!h.ridden).toBe(false);
    b.send("horse", { action: "whistle" }); // close enough: H mounts instead of calling a second horse
    await until("mounted", () => mounted(b));
    expect(horses(b).size).toBe(1);
    expect(horses(b).get(b.id).ridden).toBe(true);

    const galloped = await run(b, 14, 2.5);
    expect(galloped.corrections).toBe(0);
    expect(galloped.moved).toBeGreaterThan(30); // 35 m in 2.5 s
    const hh = horses(b).get(b.id);
    const parked = { x: hh.x, y: hh.y, z: hh.z }; // a ridden horse's synced spot doesn't stream (clients draw it under the rider)
    expect(Math.hypot(parked.x - me(b).x, parked.y - me(b).y, parked.z - me(b).z)).toBeGreaterThan(25);

    // No weapons from the saddle.
    b.send("fire", { slot: 0, ox: me(b).x, oy: me(b).y, oz: me(b).z, dx: 1, dy: 0, dz: 0, t: Date.now() });
    await until("fire refused", () => b.last("denied")?.action === "fire");
    expect(b.last("denied").reason).toBe("mounted");

    b.send("horse", { action: "dismount" });
    await until("dismounted", () => !mounted(b));
    expect(horses(b).get(b.id).ridden).toBe(false);
    await until("the horse steps out beside the rider", () => {
      const h = horses(b).get(b.id);
      return Math.hypot(h.x - me(b).x, h.y - me(b).y, h.z - me(b).z) < 3;
    });
    await sleep(HORSE.dismountGraceMs + 100);
    const sprinted = await run(b, 14, 2.5);
    expect(sprinted.corrections).toBeGreaterThan(0);
    expect(sprinted.moved).toBeLessThan(30);
  });

  it("NPC slows hold the horse back too: chilled to half speed, a full gallop is corrected", async () => {
    const b = await rider("chilled");
    await summonAndMount(b);
    const a = serverRoom(b).playerById(b.id)!;
    applyMoveEffect(a, { kind: "slow", amount: 0.5, seconds: 8 }, Date.now());
    const slowed = await run(b, 7.5, 2);
    expect(slowed.corrections).toBe(0);
    const galloped = await run(b, HORSE.sprint, 2);
    expect(galloped.corrections).toBeGreaterThan(0);
  });

  it("ignores E spam: getting on and off waits HORSE.toggleCooldownMs between changes", async () => {
    const b = await rider("spammer");
    await summonAndMount(b); // 2 messages
    const events = () => b.count("horse");
    const before = events();
    for (let i = 0; i < 3; i++) b.send("horse", { action: "ride" }); // 5 this second: under the rate limit
    await sleep(250);
    expect(mounted(b)).toBe(true); // too soon after getting on
    await sleep(1000); // next rate window, well past the toggle cooldown
    b.send("horse", { action: "dismount" });
    await until("off", () => !mounted(b));
    for (let i = 0; i < 3; i++) b.send("horse", { action: "ride" });
    await sleep(250);
    expect(mounted(b)).toBe(false);
    expect(events() - before).toBeLessThanOrEqual(1); // the one dismount (owners hear their own events)
  });

  it("drops horse messages past HORSE.messagesPerSecond without a reply", async () => {
    const b = await rider("flooder", false); // no whistle: every whistle that gets through is refused
    for (let i = 0; i < 20; i++) b.send("horse", { action: "whistle" });
    await until("refusals", () => b.count("denied") >= HORSE.messagesPerSecond);
    await sleep(300);
    expect(b.count("denied")).toBe(HORSE.messagesPerSecond);
  });

  it("a big hit throws the rider; losing the whistle sends the horse away; an idle horse leaves after 30 s", async () => {
    const b = await rider("rodeo");
    await summonAndMount(b);
    b.send("admin", { cmd: "damage", args: { amount: 10 } }); // a scratch: still riding
    await until("hurt", () => me(b).hp <= me(b).maxHp - 10);
    await sleep(150);
    expect(mounted(b)).toBe(true);
    b.send("admin", { cmd: "damage", args: { amount: Math.ceil(me(b).maxHp * HORSE.throwFraction) } });
    await until("thrown", () => !mounted(b));
    expect(b.toasts).toContain("Thrown from the saddle!");
    expect(horses(b).has(b.id)).toBe(true);

    // The idle timer: pretend the dismount was 30 s ago.
    horseSystem(b).horses.get(b.id)!.idleSince = Date.now() - HORSE.idleDespawnMs;
    await until("idle horse leaves", () => !horses(b).has(b.id));

    await sleep(HORSE.whistleCooldownMs);
    await summonAndMount(b);
    const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((it: any) => it?.id === HORSE_WHISTLE);
    b.send("drop", { slot });
    await until("no whistle, no horse", () => !horses(b).has(b.id) && !mounted(b));
  });
});

describe("combat and riders", () => {
  /** Shot from `s` (eye height) at `t`'s up-axis `above` metres over its feet (server positions). */
  function aim(s: Bot, t: Bot, above: number) {
    const a = serverRoom(s).playerById(s.id)!.state, b = serverRoom(t).playerById(t.id)!.state;
    const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
    const o: V3 = [a.x + (a.x / la) * 1.6, a.y + (a.y / la) * 1.6, a.z + (a.z / la) * 1.6];
    const p: V3 = [b.x + (b.x / lb) * above, b.y + (b.y / lb) * above, b.z + (b.z / lb) * above];
    const d = norm([p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
    return { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], t: Date.now() };
  }

  it("no weapons from the saddle or during the horse-speed grace after getting off; no scope while mounted", async () => {
    const b = await rider("dismounter");
    await summonAndMount(b);
    b.send("scope", { on: true });
    await sleep(HORSE.toggleCooldownMs); // also lets the next E count
    expect(me(b).flags & PF.SCOPED).toBe(0);
    b.send("horse", { action: "dismount" });
    await until("off", () => !mounted(b));
    const shot = () => {
      const a = me(b);
      const l = Math.hypot(a.x, a.y, a.z);
      const o: V3 = [a.x + (a.x / l) * 1.6, a.y + (a.y / l) * 1.6, a.z + (a.z / l) * 1.6];
      return { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: a.fx || 1, dy: a.fy, dz: a.fz, t: Date.now() };
    };
    b.send("fire", shot()); // the server still budgets horse speed for in-flight inputs: no shooting yet
    await until("refused", () => b.last("denied")?.action === "fire");
    expect(b.last("denied").reason).toBe("mounted");
    await sleep(HORSE.dismountGraceMs);
    const shots = b.count("shot");
    b.send("fire", shot());
    await until("on foot it fires", () => b.count("shot") > shots);
  });

  it("the hit capsule rides in the saddle: the drawn head is a weak point, the horse's legs are not the rider", async () => {
    const r = await rider("target");
    const s = await bot("gunner", BODY, "admin", { starter: 3 });
    await tpAndWait(s, offPad(BODY, 0, 52));
    s.send("admin", { cmd: "unprotect" });
    s.send("scope", { on: true }); // carbine spread 1.5° → 0.3° scoped: ±6 cm at 12 m
    await sleep(300);
    const hp0 = me(r).hp;
    const head = HORSE.riderLift + 1.6; // a seated rider's head (2.2–2.45 m drawn); on foot the capsule tops out at 1.8
    s.send("fire", aim(s, r, head)); // on foot that is over their head
    await sleep(400);
    expect(me(r).hp).toBe(hp0);

    await summonAndMount(r);
    await sleep(300);
    s.send("fire", aim(s, r, 0.35)); // the horse's legs
    await sleep(400);
    expect(me(r).hp).toBe(hp0);
    s.send("fire", aim(s, r, head));
    await until("a weak-point hit on the rider", () => !!s.msgs.get("hit")?.some((h: any) => h.target === r.id && h.weak));
    await until("damage", () => me(r).hp < hp0);
  });
});

describe("the horse leaves with its owner", () => {
  it("on death: the whistle drops in the pile like everything else", async () => {
    const b = await rider("fallen");
    await summonAndMount(b);
    b.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await until("death", () => b.count("death") > 0);
    const pile = pileStore.current.get(b.last("death").pileId)!;
    expect(pile.items.map((i) => i.id)).toContain(HORSE_WHISTLE);
    await until("horse gone", () => !horses(b).has(b.id));
  });

  it("on a teleport (fast travel, quest triggers, admin): the horse doesn't come along", async () => {
    const b = await rider("blinker");
    await summonAndMount(b);
    b.send("admin", { cmd: "teleport", args: (() => { const p = offPad(BODY, 0, 240); return { x: p[0], y: p[1], z: p[2] }; })() });
    await until("no horse, not mounted", () => !horses(b).has(b.id) && !mounted(b));
  });

  it("when the rider leaves outside a safe zone: the lingering body stands, unmounted, without a horse", async () => {
    const watcher = await bot("watcher2", BODY);
    const r = await rider("leaver");
    await summonAndMount(r);
    await until("watcher sees the rider mounted", () => !!((horses(watcher).get(r.id)?.ridden) && (watcher.room.state as any).players.get(r.id).flags & PF.MOUNTED));
    const rid = r.id;
    await r.room.leave(true);
    await until("lingering, not mounted", () => {
      const p = (watcher.room.state as any).players.get(rid);
      return !!p && !!(p.flags & PF.LINGER) && !(p.flags & PF.MOUNTED);
    });
    expect(horses(watcher).has(rid)).toBe(false);
    expect(serverRoom(watcher).lingering.get(rid)?.actor.mounted).toBeFalsy();
  });

  it("on travel through a portal and on logout", async () => {
    const watcher = await bot("watcher", BODY);
    // Portals stand in a pad's safe ring: mount just outside it, ride to the portal, travel.
    const spot = portalSpots(BODIES[BODY], terrain(BODY))[0]!;
    const R = BODIES[BODY].radius + spot.h;
    const portal: V3 = [spot.dir[0] * R, spot.dir[1] * R, spot.dir[2] * R];
    const t = await rider("tourist", true, outsideSafe(portal));
    expect(t.room.roomId).toBe(watcher.room.roomId);
    await summonAndMount(t);
    await until("watcher sees the horse", () => horses(watcher).has(t.id));
    await rideToward(t, portal, 8, 1);
    expect(mounted(t)).toBe(true);
    t.send("travel", { to: spot.to });
    await until("ticket", () => t.count("travelOk") > 0);
    const tid = t.id;
    await safeLeave(t.room);
    await until("horse gone after travel", () => !horses(watcher).has(tid));
    const there = await joinAs(harness.game!, "tourist", spot.to, {}, "admin", false);
    harness.rooms.push(there);
    await waitFor(() => (there.state as any).players?.get(there.sessionId) !== undefined);
    expect((there.state as any).horses.size).toBe(0);

    // Logout: mount just outside the pad's safe ring, ride in (instant logout there), log out.
    const l = await rider("homebody", true, offPad(BODY, 0, 15));
    await summonAndMount(l);
    await until("watcher sees it", () => horses(watcher).has(l.id));
    await rideToward(l, padAt(BODY, 0) as V3, 8, 6);
    await until("safe", () => !!(me(l).flags & PF.SAFE));
    expect(mounted(l)).toBe(true);
    const lid = l.id;
    l.send("logout", { start: true });
    await until("logged out", () => l.count("loggedOut") > 0);
    await until("horse gone after logout", () => !horses(watcher).has(lid));
  });
});

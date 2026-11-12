// The spellbook on the real path (content §2.6): bots send `cast` like the client; the server's
// spell system, combat pipeline and movement validation answer. Each spell: cost, cooldown, level
// gate, safe-zone refusal, damage to a creature and to a player; Skipstep against a wall; the ward
// absorbing; the slow ending.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES } from "@firstlight/shared";
import { AETHER, aetherAt, FROSTBLOOM, GLASSWING, SKIPSTEP, SPELLS, spellDamage, WISHFALL, type SpellId, type SpellsYou } from "@firstlight/shared/content/spells";
import { maxHp } from "@firstlight/shared/content/progression";
import type { SpellEvent } from "@firstlight/shared/net/protocol";
import { townDir } from "@firstlight/shared/planet/townFrame";
import type { Game } from "../src/app.ts";
import { npcSpeedFactor, type NpcActor, type PlayerActor } from "../src/world/actors.ts";
import { dealDamage } from "../src/world/combat.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { onGameEvent } from "../src/world/events.ts";
import { moveLimits } from "../src/world/movement.ts";
import { SpellSystem } from "../src/world/spells/SpellSystem.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { adminBot, flat, me, nearPad, offset, openSpotOutside, serverRoom, spawnNpc, type V } from "./npc-bots.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const R = BODIES.arcadia.radius;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pos = (r: Room): V => [me(r).x, me(r).y, me(r).z];
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const dirTo = (a: readonly number[], b: readonly number[]): V => {
  const l = d3(a, b);
  return [(b[0]! - a[0]!) / l, (b[1]! - a[1]!) / l, (b[2]! - a[2]!) / l];
};
const actor = (r: Room): PlayerActor => serverRoom(r).actors.get(r.sessionId)!;
const npc = (r: Room, id: string): NpcActor => serverRoom(r).npcActors.get(id)!;
/** A player's HP on the server (the synced copy lags a patch behind the messages). */
const hpOf = (r: Room): number => actor(r).state.hp;
const until = (label: string, cond: () => boolean, ms?: number) => waitFor(cond, ms).catch(() => {
  throw new Error(`timed out waiting for: ${label}`);
});

const spells = (r: Room): SpellSystem => serverRoom(r).systems.find((s) => s instanceof SpellSystem) as SpellSystem;
/** These tests wait on the server's real timers (cooldowns, the star's fall); the machine is shared. */
const SLOW = 60_000;

/** What a bot hears about spells: its `you.spells`, the refusals and the `spell` events. */
function listen(r: Room) {
  const heard = { you: null as SpellsYou | null, denied: [] as string[], events: [] as SpellEvent[], corrects: [] as V[] };
  r.onMessage("you", (m: { spells?: SpellsYou }) => (heard.you = m.spells ?? null));
  r.onMessage("denied", (m: { action: string; reason: string }) => {
    if (m.action === "cast") heard.denied.push(m.reason);
  });
  r.onMessage("spell", (m: SpellEvent) => heard.events.push(m));
  r.onMessage("correct", (m: { x: number; y: number; z: number }) => heard.corrects.push([m.x, m.y, m.z]));
  return heard;
}

function cast(r: Room, spell: SpellId, dir: readonly number[] = [me(r).fx, me(r).fy, me(r).fz], target?: readonly number[]) {
  r.send("cast", { spell, dx: dir[0], dy: dir[1], dz: dir[2], ...(target ? { tx: target[0], ty: target[1], tz: target[2] } : {}) });
}

/** Full aether and no cooldowns (the admin `spells` command), confirmed by a `you`. */
async function refill(r: Room, heard: ReturnType<typeof listen>) {
  heard.you = null;
  r.send("admin", { cmd: "spells", args: { refill: true } });
  await until("refilled", () => heard.you?.aether === AETHER.max && heard.you.ready.every((x) => x === 0));
}

const cost = (id: SpellId) => SPELLS.find((s) => s.id === id)!.cost;
const index = (id: SpellId) => SPELLS.findIndex((s) => s.id === id);

/** Shorten a catalogue number for one test; returns the restore. */
function shorten(obj: object, key: string, value: number): () => void {
  const o = obj as Record<string, number>;
  const was = o[key]!;
  o[key] = value;
  return () => void (o[key] = was);
}

/** The private state caught up with a cast: `id`'s cost is gone from a full book. */
const spent = (h: ReturnType<typeof listen>, id: SpellId) => until(`${id} paid for`, () => Math.abs((h.you?.aether ?? -1) - (AETHER.max - cost(id))) < 0.6);

describe("spellbook: gates, aether and cooldowns", () => {
  it("level gates: a level-1 character has Skipstep only; each spell opens at its level", async () => {
    const base = openSpotOutside("arcadia", 14);
    const a = await adminBot(game, rooms, "novice", "arcadia", base, 1);
    const h = listen(a);
    for (const s of SPELLS) {
      await refill(a, h);
      h.denied.length = 0;
      a.send("admin", { cmd: "level", args: { level: Math.max(1, s.level - 1) } });
      await until(`level ${s.level - 1}`, () => me(a).level === Math.max(1, s.level - 1));
      cast(a, s.id, dirTo(base, offset(base, 5, 0, R)));
      if (s.level > 1) {
        await until(`${s.id} locked`, () => h.denied.includes("locked"));
        expect(h.events.filter((e) => e.spell === s.id)).toHaveLength(0);
        a.send("admin", { cmd: "level", args: { level: s.level } });
        await until(`level ${s.level}`, () => me(a).level === s.level);
        cast(a, s.id, dirTo(base, offset(base, 5, 0, R)));
      }
      await until(`${s.id} cast at level ${s.level}`, () => h.events.some((e) => e.spell === s.id && e.phase === "cast"));
      await sleep(450); // five casts a second at most
    }
    expect(SPELLS.map((s) => s.level)).toEqual([1, 3, 6, 9]);
  }, SLOW);

  it("a cast spends its aether and starts its cooldown; aether waits 1.5 s, then refills; no aether, no cast", async () => {
    const base = openSpotOutside("arcadia", 14);
    const a = await adminBot(game, rooms, "caster", "arcadia", base, 9);
    const h = listen(a);
    await refill(a, h);
    const t0 = Date.now();
    cast(a, "glasswing");
    await until("ward cast", () => (h.you?.aether ?? 100) < AETHER.max);
    await spent(h, "glasswing");
    expect(h.you!.ready[index("glasswing")]! - t0).toBeGreaterThan(17_500);
    expect(h.you!.ready[index("glasswing")]! - t0).toBeLessThan(19_000);
    expect(h.you!.regenAt - t0).toBeGreaterThan(1400);
    // Still cooling down.
    cast(a, "glasswing");
    await until("cooldown refusal", () => h.denied.includes("cooldown"));
    // 65 left: Wishfall (45) goes, then Frostbloom (30) can't (20 left).
    cast(a, "wishfall", dirTo(base, offset(base, 5, 0, R)));
    await until("wishfall cast", () => h.events.some((e) => e.spell === "wishfall" && e.phase === "cast"));
    cast(a, "frostbloom");
    await until("aether refusal", () => h.denied.includes("aether"));
    expect(h.events.some((e) => e.spell === "frostbloom")).toBe(false);
    // The book refills only after the pause, at 6 a second: what `you` says is the shared function of the server's book.
    const b = { ...spells(a).book(actor(a), Date.now()) };
    expect(b.aether).toBeCloseTo(AETHER.max - cost("glasswing") - cost("wishfall"), 0);
    expect(aetherAt(b, b.regenAt)).toBe(b.aether);
    await sleep(Math.max(0, b.regenAt - Date.now()) + 1000);
    h.you = null;
    actor(a).youDirty = true;
    await until("a fresh you", () => !!h.you);
    expect(h.you!.t).toBeGreaterThan(b.regenAt + 900);
    expect(h.you!.aether).toBeCloseTo(aetherAt(b, h.you!.t), 0);
    expect(h.you!.aether).toBeGreaterThan(b.aether + AETHER.regenPerS * 0.8);
  }, SLOW);

  it("safe zones refuse every spell (nothing spent); the game event bus hears a cast; casts are rate-limited", async () => {
    const pad = nearPad("arcadia", 0, 2);
    const a = await adminBot(game, rooms, "padded", "arcadia", pad, 9);
    const h = listen(a);
    await refill(a, h);
    for (const s of SPELLS) {
      h.denied.length = 0;
      cast(a, s.id, dirTo(pad, offset(pad, 5, 0, R)));
      await until(`${s.id} refused on the pad`, () => h.denied.includes("safe zone"));
      await sleep(210); // five casts a second
    }
    expect(h.events).toHaveLength(0);
    expect(d3(pos(a), pad)).toBeLessThan(2);
    actor(a).youDirty = true;
    await sleep(120);
    expect(h.you!.aether).toBe(AETHER.max);

    // Out in the open the bus reports the cast.
    const base = openSpotOutside("arcadia", 14);
    const seen: string[] = [];
    const off = onGameEvent(serverRoom(a), (e) => {
      if (e.type === "spellCast") seen.push(`${e.playerId}:${e.spell}`);
    });
    a.send("admin", { cmd: "teleport", args: { x: base[0], y: base[1], z: base[2] } });
    await until("out in the open", () => flat(pos(a), base) < 2 && !serverRoom(a).safeNow(actor(a), Date.now()));
    await sleep(1000); // a fresh rate window
    cast(a, "glasswing");
    await until("bus heard it", () => seen.includes(`${a.sessionId}:glasswing`));
    off();
    // More than five `cast` a second are dropped unanswered.
    await sleep(1000);
    h.denied.length = 0;
    for (let i = 0; i < 12; i++) cast(a, "glasswing");
    await sleep(400);
    expect(h.denied.length).toBeGreaterThan(0);
    expect(h.denied.length).toBeLessThanOrEqual(5);
  }, SLOW);
});

describe("Skipstep", () => {
  it("blinks 10 m along the aim over open ground: the server moves the body, says so, and drops inputs from the old place", async () => {
    const base = openSpotOutside("arcadia", 14);
    const a = await adminBot(game, rooms, "blinker", "arcadia", base, 1);
    const h = listen(a);
    await refill(a, h);
    const from = pos(a);
    const dir = dirTo(base, offset(base, 6, 0, R));
    h.corrects.length = 0;
    cast(a, "skipstep", dir);
    await until("blinked", () => h.events.some((e) => e.spell === "skipstep"));
    const e = h.events.find((x) => x.spell === "skipstep")!;
    const to: V = [e.tx!, e.ty!, e.tz!];
    expect(flat(from, to)).toBeGreaterThan(SKIPSTEP.rangeM - 0.6);
    expect(flat(from, to)).toBeLessThan(SKIPSTEP.rangeM + 0.3);
    expect(flat(to, offset(base, SKIPSTEP.rangeM, 0, R))).toBeLessThan(1.5); // along the aim
    await until("state moved", () => d3(pos(a), to) < 0.05);
    expect(h.corrects.at(-1)).toBeDefined();
    expect(d3(h.corrects.at(-1)!, to)).toBeLessThan(0.05);
    await spent(h, "skipstep");

    // The client hasn't heard yet: its inputs still come from the old place. They are dropped, not
    // answered with corrections, and the body stays where the server put it.
    h.corrects.length = 0;
    const seq0 = actor(a).state.seq ?? 0; // a bot that never moved has sent no input yet
    for (let i = 1; i <= 3; i++) a.send("input", { seq: seq0 + i, x: from[0], y: from[1], z: from[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 0, t: Date.now() });
    await until("stale inputs taken", () => actor(a).state.seq === seq0 + 3);
    expect(h.corrects).toHaveLength(0);
    expect(d3(pos(a), to)).toBeLessThan(0.05);
    // From the new place it moves on as usual.
    const step = serverRoom(a).snapToGround(offset(to, 0.4, 0, R));
    a.send("input", { seq: seq0 + 4, x: step[0], y: step[1], z: step[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 1, t: Date.now() });
    await until("walked on", () => d3(pos(a), step) < 0.05);
    expect(h.corrects).toHaveLength(0);
    // Six seconds of cooldown.
    cast(a, "skipstep", dir);
    await until("cooldown", () => h.denied.includes("cooldown"));
  });

  it("a wall shortens the blink, and a wall right ahead refuses it for free", async () => {
    // Portus: the castle ward's east wall (town-walls.test.ts): its outer face is ~2.6 m west of (19, 50).
    const RP = BODIES.portus.radius;
    const town = (east: number, north: number): V => {
      const d = townDir(east, north, RP);
      return [d[0] * RP, d[1] * RP, d[2] * RP];
    };
    const a = await adminBot(game, rooms, "walled", "portus", serverRoomless(town(24, 50)), 1);
    const room = serverRoom(a);
    const h = listen(a);
    await refill(a, h);
    const start = pos(a);
    const west = dirTo(start, room.snapToGround(town(-19, 50)));
    cast(a, "skipstep", west);
    await until("blinked", () => h.events.some((e) => e.spell === "skipstep"));
    const e = h.events.find((x) => x.spell === "skipstep")!;
    const went = flat(start, [e.tx!, e.ty!, e.tz!]);
    expect(went).toBeGreaterThanOrEqual(SKIPSTEP.minM);
    expect(went).toBeLessThan(8.5); // the wall's face is ~7.6 m off: not the full 10 m, and not through
    await until("state moved", () => d3(pos(a), [e.tx!, e.ty!, e.tz!]) < 0.05);
    // Not inside or past the wall: a straight walk back to the start crosses nothing.
    const now = pos(a);
    expect(room.moveWorld.crosses!(now[0], now[1], now[2], start[0], start[1], start[2])).toBe(false);
    expect(room.moveWorld.footing!(now[0], now[1], now[2], 0.35).inside).toBe(false);

    // Now the wall is right ahead: refused, and nothing is spent.
    await refill(a, h);
    h.events.length = 0;
    cast(a, "skipstep", west);
    await until("blocked", () => h.denied.includes("blocked"));
    expect(h.events).toHaveLength(0);
    expect(d3(pos(a), now)).toBeLessThan(0.05);
    actor(a).youDirty = true;
    await sleep(120);
    expect(h.you!.aether).toBe(AETHER.max);
    expect(h.you!.ready[index("skipstep")]).toBe(0);
  });
});

/** A point as given (the admin teleport snaps it to the ground itself). */
const serverRoomless = (p: V): V => p;

describe("Frostbloom", () => {
  it("hurts and slows creatures and players in the ring, pays the kill, and the slow ends", async () => {
    const restore = shorten(FROSTBLOOM, "slowS", 0.6);
    try {
      const base = openSpotOutside("arcadia", 14);
      const a = await adminBot(game, rooms, "frost", "arcadia", base, 3);
      const b = await adminBot(game, rooms, "chilled", "arcadia", offset(base, 3, 0, R), 3);
      const far = await adminBot(game, rooms, "farther", "arcadia", offset(base, 9, 0, R), 3);
      const h = listen(a);
      const fx: { kind: string; ms: number; amount: number }[] = [];
      b.onMessage("npcFx", (m) => fx.push(m));
      let kill: { xp: number } | null = null;
      a.onMessage("npcKill", (m: { xp: number }) => (kill = m));
      await refill(a, h);
      const tough = await spawnNpc(a, "linewyrm", offset(base, 2.5, 2, R), { level: 3, roam: 0, instant: true });
      const weak = await spawnNpc(a, "hopbit", offset(base, 2, -2, R), { level: 1, roam: 0, instant: true });
      const toughHp = npc(a, tough).state.hp;
      const dmg = Math.round(spellDamage(FROSTBLOOM.damage, 3));
      expect(dmg).toBe(25);
      expect(npc(a, weak).state.hp).toBeLessThanOrEqual(dmg);

      cast(a, "frostbloom");
      await until("frostbloom cast", () => h.events.some((e) => e.spell === "frostbloom"));
      const e = h.events.find((x) => x.spell === "frostbloom")!;
      expect(e.r).toBe(FROSTBLOOM.radiusM);
      // The creature in the ring took the level-scaled damage and walks at 60%.
      expect(toughHp - npc(a, tough).state.hp).toBe(dmg);
      const slow = npc(a, tough).slow!;
      expect(slow.amount).toBe(FROSTBLOOM.slow);
      expect(npcSpeedFactor(npc(a, tough), slow.until - 1)).toBeCloseTo(1 - FROSTBLOOM.slow);
      expect(npcSpeedFactor(npc(a, tough), slow.until)).toBe(1);
      expect(e.hit).toContain(tough);
      // The weak one died of it and the caster is paid.
      await until("kill paid", () => !!kill);
      expect(kill!.xp).toBeGreaterThan(0);
      // The player in the ring (friendly fire is on) is hurt and slowed on the server and told.
      expect(maxHp(3) - hpOf(b)).toBe(dmg);
      const fxB = actor(b).npcFx!;
      expect(fxB.slow).toBe(FROSTBLOOM.slow);
      expect(fxB.slowUntil - slow.until).toBeLessThan(50); // one cast, one clock
      expect(moveLimits(actor(b), fxB.slowUntil - 1).speed).toBeCloseTo(1 - FROSTBLOOM.slow);
      expect(e.hit).toContain(b.sessionId);
      await until("the slow reached its client", () => fx.length > 0);
      expect(fx[0]).toMatchObject({ kind: "slow", amount: FROSTBLOOM.slow });
      // The caster and whoever stood outside are untouched.
      expect(hpOf(a)).toBe(maxHp(3));
      expect(hpOf(far)).toBe(maxHp(3));
      expect(e.hit).not.toContain(far.sessionId);
      await spent(h, "frostbloom");
      // …and the slow ends.
      await until("creature back to speed", () => npcSpeedFactor(npc(a, tough), Date.now()) === 1, 3000);
      await until("player back to speed", () => moveLimits(actor(b), Date.now()).speed === 1, 3000);
    } finally {
      restore();
    }
  }, SLOW);
});

describe("Wishfall", () => {
  it("warns with a ring, lands 1.2 s later with splash on creatures and players (the caster takes half), and counts as heavy on props", async () => {
    const base = openSpotOutside("arcadia", 14);
    const a = await adminBot(game, rooms, "starcaller", "arcadia", base, 6);
    const b = await adminBot(game, rooms, "struck", "arcadia", offset(base, 11, 0, R), 6);
    const h = listen(a);
    const seenByB: SpellEvent[] = [];
    b.onMessage("spell", (m: SpellEvent) => seenByB.push(m));
    await refill(a, h);
    const target = serverRoom(a).snapToGround(offset(base, 12, 0, R));
    // A placid Woolback (a Linewyrm would dash off at the player before the star lands).
    const wyrm = await spawnNpc(a, "woolback", offset(base, 12, 1.5, R), { level: 12, roam: 0, instant: true });
    const wyrmHp = npc(a, wyrm).state.hp;
    const t0 = Date.now();
    cast(a, "wishfall", dirTo(base, target), target);
    await until("ring", () => h.events.some((e) => e.spell === "wishfall" && e.phase === "cast"));
    const ring = h.events.find((e) => e.spell === "wishfall")!;
    expect(ring.ms).toBe(WISHFALL.telegraphS * 1000);
    expect(ring.r).toBe(WISHFALL.radiusM);
    expect(d3([ring.x, ring.y, ring.z], target)).toBeLessThan(0.6);
    await until("the victim sees the ring too", () => seenByB.some((e) => e.spell === "wishfall" && e.phase === "cast"));
    // Nothing lands before the warning is over: while the star is still on its way, nobody is hurt,
    // and it is due a full warning after the cast was sent.
    const star = spells(a).stars[0];
    if (star) {
      expect(star.landAt - t0).toBeGreaterThanOrEqual(WISHFALL.telegraphS * 1000);
      expect(npc(a, wyrm).state.hp).toBe(wyrmHp);
      expect(hpOf(b)).toBe(maxHp(6));
    }
    await until("impact", () => h.events.some((e) => e.spell === "wishfall" && e.phase === "impact"), 8000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(WISHFALL.telegraphS * 1000 - 60);
    // 60 × 1.15 at the centre, falling to 25% at the 4 m edge: both stood 1–2 m off it.
    const full = spellDamage(WISHFALL.damage, 6);
    const wyrmLost = wyrmHp - npc(a, wyrm).state.hp;
    const playerLost = maxHp(6) - hpOf(b);
    for (const lost of [wyrmLost, playerLost]) {
      expect(lost).toBeGreaterThan(full * 0.45);
      expect(lost).toBeLessThanOrEqual(Math.round(full));
    }
    expect(hpOf(a)).toBe(maxHp(6)); // 12 m away
    await spent(h, "wishfall");

    // On your own feet it hurts you too, at half (own explosives rule).
    await refill(a, h);
    h.events.length = 0;
    cast(a, "wishfall", dirTo(base, target), pos(a));
    await until("own impact", () => h.events.some((e) => e.phase === "impact"), 8000);
    const self = maxHp(6) - hpOf(a);
    expect(self).toBeGreaterThan(full * 0.5 * 0.8);
    expect(self).toBeLessThanOrEqual(Math.round(full * 0.5));
  }, SLOW);

  it("a far target is pulled in to 30 m, and a star breaks what only heavy attacks break", async () => {
    const a = await adminBot(game, rooms, "wrecker", "hollowmere", nearPad("hollowmere", 0, 2), 20);
    const room = serverRoom(a);
    const h = listen(a);
    const sys = room.systems.find((s) => s instanceof DestructionSystem) as DestructionSystem;
    const R2 = BODIES.hollowmere.radius;
    // A statue with open ground 8 m from it.
    let statue: (typeof sys.list)[number] | null = null;
    let stand: V | null = null;
    for (const s of sys.list) {
      if (s.kind !== "statue") continue;
      for (let k = 0; k < 12 && !stand; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const p = room.snapToGround([s.px + (s.rx * Math.cos(ang) + s.fx * Math.sin(ang)) * 8, s.py + (s.ry * Math.cos(ang) + s.fy * Math.sin(ang)) * 8, s.pz + (s.rz * Math.cos(ang) + s.fz * Math.sin(ang)) * 8]);
        const h0 = Math.hypot(p[0], p[1], p[2]) - R2;
        if (h0 < BODIES.hollowmere.waterLevel + 0.5 || room.moveWorld.footing!(p[0], p[1], p[2], 0.35).inside) continue;
        a.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
        a.send("admin", { cmd: "unprotect" });
        await until("placed", () => d3(pos(a), p) < 3);
        if (!room.safeNow(actor(a), Date.now())) stand = p;
      }
      if (stand) {
        statue = s;
        break;
      }
    }
    expect(statue, "a statue with room beside it").not.toBeNull();
    await refill(a, h);
    const hp0 = sys.hp[statue!.index]!;
    // Frostbloom is light: a statue shrugs it off even point blank… (we are 8 m off: cast the star first)
    cast(a, "wishfall", dirTo(pos(a), [statue!.px, statue!.py, statue!.pz]), [statue!.px, statue!.py, statue!.pz]);
    await until("impact", () => h.events.some((e) => e.spell === "wishfall" && e.phase === "impact"), 8000);
    expect(sys.hp[statue!.index]!).toBeLessThan(hp0);

    // 80 m away along the aim is pulled in to the 30 m range.
    await refill(a, h);
    h.events.length = 0;
    const here = pos(a);
    const farPoint = offset(here, 80, 0, R2);
    cast(a, "wishfall", dirTo(here, farPoint), farPoint);
    await until("ring", () => h.events.some((e) => e.spell === "wishfall" && e.phase === "cast"));
    const ring = h.events.find((e) => e.spell === "wishfall")!;
    expect(d3([ring.x, ring.y, ring.z], here)).toBeLessThanOrEqual(WISHFALL.rangeM + 3);
  }, SLOW);
});

describe("Glasswing Ward", () => {
  it("soaks 30% of max HP from attackers, lets the rest through, breaks, and runs out by itself", async () => {
    // A long shell, so a slow machine can't let it run out mid-test (its 4 s are the next test's).
    const restore = shorten(GLASSWING, "durationS", 30);
    try {
      const base = openSpotOutside("arcadia", 14);
      const a = await adminBot(game, rooms, "warded", "arcadia", base, 9);
      const b = await adminBot(game, rooms, "gunner", "arcadia", offset(base, 6, 0, R), 9);
      const h = listen(a);
      await refill(a, h);
      const shell = Math.round((GLASSWING.absorbPer100MaxHp / 100) * maxHp(9));
      expect(shell).toBe(54);
      cast(a, "glasswing");
      await until("ward up", () => h.you?.ward?.hp === shell);
      expect(h.events.find((e) => e.spell === "glasswing" && e.phase === "cast")).toMatchObject({ by: a.sessionId, ms: GLASSWING.durationS * 1000, hp: shell });

      // A real carbine shot from another player: the shell takes it, the HP doesn't move.
      const s = pos(b), t = pos(a);
      const l = Math.hypot(...s), tl = Math.hypot(...t);
      const o = [s[0] + (s[0] / l) * 1.6, s[1] + (s[1] / l) * 1.6, s[2] + (s[2] / l) * 1.6];
      const aim = [t[0] + t[0] / tl, t[1] + t[1] / tl, t[2] + t[2] / tl];
      const d = dirTo(o, aim);
      b.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], t: Date.now() });
      await until("absorbed", () => h.events.some((e) => e.phase === "absorb"));
      const soak = h.events.find((e) => e.phase === "absorb")!;
      expect(soak).toMatchObject({ by: a.sessionId, from: b.sessionId });
      expect(soak.amount).toBeGreaterThan(0);
      expect(hpOf(a)).toBe(maxHp(9));
      expect(soak.hp).toBe(shell - soak.amount!);

      // A hit bigger than what is left: the rest gets through and the shell breaks.
      const left = soak.hp!;
      dealDamage(serverRoom(a).host, actor(b), actor(a), left + 20, false);
      await until("ward broke", () => h.events.some((e) => e.phase === "end" && e.broke === true));
      expect(hpOf(a)).toBe(maxHp(9) - 20);
      // No shell any more: the next shot hurts.
      const hp = hpOf(a);
      await sleep(300);
      b.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], t: Date.now() });
      await until("hurt", () => hpOf(a) < hp);
      expect(h.you!.ready[index("glasswing")]).toBeGreaterThan(Date.now() + 10_000);
    } finally {
      restore();
    }
  }, SLOW);

  it("ends after its 4 s, and never takes falls or other damage with no attacker", async () => {
    const restore = shorten(GLASSWING, "durationS", 0.5);
    try {
      const base = openSpotOutside("arcadia", 14);
      const a = await adminBot(game, rooms, "timed", "arcadia", base, 9);
      const h = listen(a);
      await refill(a, h);
      cast(a, "glasswing");
      await until("ward up", () => !!h.you?.ward);
      // Damage with no attacker (a fall, the admin command) passes the shell.
      a.send("admin", { cmd: "damage", args: { amount: 10 } });
      await until("world damage landed", () => hpOf(a) === maxHp(9) - 10);
      expect(h.events.some((e) => e.phase === "absorb")).toBe(false);
      await until("ward timed out", () => h.events.some((e) => e.phase === "end" && !e.broke), 3000);
      await until("you says no ward", () => !!h.you && !h.you.ward);
    } finally {
      restore();
    }
  });
});

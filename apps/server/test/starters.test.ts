// Per-starter stats (issue #9, D-balance-4): max HP on the server, the run budget and the dodge
// cooldown in movement validation, from the same shared table the client predicts with.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { ANIM } from "@firstlight/shared/net/schema";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { STARTER_STATS, starterMaxHp, starterMove } from "@firstlight/shared/content/starters";
import { maxHp } from "@firstlight/shared/content/progression";
import type { Game } from "../src/app.ts";
import { MOVE, motionFields, moveLimits, validateMove, type MoveWorld } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

const idx = (id: string) => STARTER_STATS.findIndex((s) => s.id === id);
const ASH = idx("ash"), KAPPA = idx("kappa"), NINJA = idx("ninja"), HEX = idx("hexwick");

describe("the table", () => {
  it("has a row for every starter, in STARTERS order, each within the light layer's ±15%", () => {
    expect(STARTER_STATS.map((s) => s.id)).toEqual(STARTERS.map((s) => s.id));
    for (const s of STARTER_STATS) {
      expect(Math.abs(s.hp - 1)).toBeLessThanOrEqual(0.15);
      expect(Math.abs(s.speed - 1)).toBeLessThanOrEqual(0.15);
      expect(s.dodgeCooldown).toBeGreaterThanOrEqual(1);
      expect(s.dodgeCooldown).toBeLessThanOrEqual(1.4);
    }
  });

  it("Brother Ash is the sturdiest and slowest, Hinoko the fastest, Kappa rolls most often", () => {
    expect(starterMaxHp(ASH, 1)).toBe(Math.max(...STARTER_STATS.map((_, i) => starterMaxHp(i, 1))));
    expect(starterMove(ASH).sprint).toBe(Math.min(...STARTER_STATS.map((_, i) => starterMove(i).sprint)));
    expect(starterMove(NINJA).sprint).toBe(Math.max(...STARTER_STATS.map((_, i) => starterMove(i).sprint)));
    expect(starterMove(KAPPA).dodgeCooldown).toBe(Math.min(...STARTER_STATS.map((_, i) => starterMove(i).dodgeCooldown)));
  });
});

describe("movement validation per starter", () => {
  const flat: MoveWorld = { radius: 1000, waterLevel: -100, groundAt: () => 0 };
  function actor(starter: number, now: number): PlayerActor {
    return { ...motionFields(1000, now), lastX: 0, lastY: 0, lastZ: 1000, state: { x: 0, y: 0, z: 1000 }, mounted: false, mountGraceUntil: 0, char: { starter } } as unknown as PlayerActor;
  }
  /** 20 Hz packets along a great circle on the flat world; returns the refusals. */
  function run(starter: number, packets: number, at: (i: number) => { metres: number; anim: number }, emptyBank = false): number {
    let now = 1_000_000;
    const a = actor(starter, now - 5000);
    if (emptyBank) {
      a.moveBudget = 0;
      a.lastBudgetAt = now;
    }
    let refused = 0;
    let arc = 0;
    for (let i = 0; i < packets; i++) {
      now += 50;
      const { metres, anim } = at(i);
      const t = arc + metres / 1000;
      const m = { x: Math.sin(t) * 1000, y: 0, z: Math.cos(t) * 1000, anim };
      if (validateMove(a, m, flat, moveLimits(a, now), now).ok) {
        a.lastX = m.x;
        a.lastZ = m.z;
        arc = t;
      } else refused++;
    }
    return refused;
  }
  const sprintAt = (v: number) => () => ({ metres: v * 0.05, anim: ANIM.SPRINT });

  it("moveLimits carries the starter's sprint and dodge cooldown", () => {
    for (let i = 0; i < STARTERS.length; i++) {
      const l = moveLimits(actor(i, 0), 0);
      expect(l.sprint).toBeCloseTo(starterMove(i).sprint);
      expect(l.dodgeCooldownMs).toBeCloseTo(starterMove(i).dodgeCooldown * 1000);
    }
  });

  it("every starter sprints at its own speed for 60 s without one correction", () => {
    for (let i = 0; i < STARTERS.length; i++) expect(run(i, 1200, sprintAt(starterMove(i).sprint)), STARTERS[i]!.name).toBe(0);
  });

  it("a fast starter (Hinoko) is not rubber-banded at a speed the base would refuse", () => {
    const v = starterMove(NINJA).sprint * MOVE.speedSlack * 0.98; // above the base allowance (10.8 m/s)
    expect(v).toBeGreaterThan(MOVE.maxSpeed * MOVE.speedSlack);
    expect(run(NINJA, 400, sprintAt(v))).toBe(0);
    expect(run(KAPPA, 400, sprintAt(v))).toBeGreaterThan(0);
  });

  it("a slow starter (Brother Ash) can't exceed its own cap: a speed the base allows is corrected", () => {
    const v = (starterMove(ASH).sprint + MOVE.maxSpeed) / 2 * MOVE.speedSlack; // between Ash's allowance and the base's
    expect(run(STARTER_STATS.length, 400, sprintAt(v))).toBe(0); // the base row (no starter) passes
    expect(run(ASH, 400, sprintAt(v))).toBeGreaterThan(0);
    expect(run(ASH, 400, sprintAt(starterMove(ASH).sprint))).toBe(0);
  });

  // The client's roll (PlayerController): 15 m/s for ~1/3 s, easing back to the starter's sprint.
  function rollCycle(starter: number, everyS: number) {
    const v = starterMove(starter).sprint;
    const ease = [15, 15, 15, 15, 15, 15, 15, v + 2.4, v + 0.96, v + 0.39, v + 0.15, v + 0.06];
    const every = Math.round(everyS / 0.05);
    return (i: number) => {
      const k = i % every;
      return k < ease.length ? { metres: ease[k]! * 0.05, anim: k < 7 ? ANIM.DODGE : ANIM.SPRINT } : { metres: v * 0.05, anim: ANIM.SPRINT };
    };
  }

  it("each starter rolling at its own cooldown for 60 s is never corrected, even from an empty bank", () => {
    for (let i = 0; i < STARTERS.length; i++) {
      const cd = starterMove(i).dodgeCooldown;
      expect(run(i, 1200, rollCycle(i, cd)), STARTERS[i]!.name).toBe(0);
      expect(run(i, 1200, rollCycle(i, cd), true), `${STARTERS[i]!.name} from an empty bank`).toBe(0);
    }
  });

  it("a roll's burst comes only after the starter's own cooldown: Kappa may roll again at 1.05 s, Brother Ash may not", () => {
    const burstAfter = (starter: number, gapMs: number) => {
      let now = 1_000_000;
      const a = actor(starter, now - 5000);
      const roll = () => {
        now += 50;
        const x = a.lastX + 0.75;
        const l = Math.hypot(x, 0, 1000);
        const m = { x: (x / l) * 1000, y: 0, z: (1000 / l) * 1000, anim: ANIM.DODGE };
        expect(validateMove(a, m, flat, moveLimits(a, now), now).ok).toBe(true);
        a.lastX = m.x;
        a.lastZ = m.z;
      };
      roll();
      const first = a.lastDodgeAt;
      now += gapMs - 50;
      roll();
      return a.lastDodgeAt !== first;
    };
    expect(burstAfter(KAPPA, 1050)).toBe(true);
    expect(burstAfter(ASH, 1050)).toBe(false);
    expect(burstAfter(ASH, 1400)).toBe(true);
  });
});

describe("max HP per starter (server)", () => {
  let game: Game;
  const rooms: Room[] = [];
  beforeEach(async () => {
    game = await startServer();
  });
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game.close();
  });
  const me = (r: Room) => (r.state as any)?.players?.get(r.sessionId);

  it("a fresh character joins with its starter's max HP, full", async () => {
    for (const s of [HEX, ASH]) {
      const r = await joinAs(game, `hp-${s}`, "arcadia", { starter: s });
      rooms.push(r);
      await waitFor(() => !!me(r));
      expect(me(r).maxHp).toBe(starterMaxHp(s, 1));
      expect(me(r).hp).toBe(starterMaxHp(s, 1));
    }
    expect(starterMaxHp(ASH, 1)).toBeGreaterThan(maxHp(1));
    expect(starterMaxHp(HEX, 1)).toBeLessThan(maxHp(1));
  });

  it("levelling keeps the multiplier", async () => {
    const r = await joinAs(game, "hp-level", "arcadia", { starter: ASH }, "admin");
    rooms.push(r);
    await waitFor(() => !!me(r));
    r.send("admin", { cmd: "level", args: { level: 12 } });
    await waitFor(() => me(r).level === 12);
    expect(me(r).maxHp).toBe(starterMaxHp(ASH, 12));
  });
});

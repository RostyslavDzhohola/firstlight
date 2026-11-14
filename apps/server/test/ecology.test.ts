// The food chain, first version (#15): populations per region cell instead of respawn timers for
// Woolbacks and Dusk Wolves; wolves hunt herds on their own; a cleared herd walks back in.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ECO } from "@firstlight/shared/content/ecology";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { dealDamage } from "../src/world/combat.ts";
import { crowdK, newCell, stepCells, type EcoCell } from "../src/world/npc/ecology.ts";
import { MODE } from "../src/world/npc/npc.ts";
import { startHunts } from "../src/world/npc/brain.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  resetTuning();
  NPC_TUNING.bosses = false;
});
afterEach(() => resetTuning());

const PLANETS = ["arcadia", "hollowmere", "meridian"] as const;

function inBounds(c: EcoCell): boolean {
  const k = crowdK(c);
  // Kills can push a cell under its floor for a moment; the floor refills it within minutes.
  return c.w >= 0 && c.p >= 0 && c.w <= ECO.ceiling * k + 1e-9 && c.p <= ECO.ceiling * c.kp + 1e-9 && c.f >= 0 && c.f <= 1 && Number.isFinite(c.w + c.p + c.f);
}

/** A copy of the cells' numbers (to run two futures from one present). */
const clone = (cells: EcoCell[]) => cells.map((c) => ({ ...c }));

describe("food chain model (#15)", () => {
  it("12 hours with nobody near: every cell on every planet stays between its floor and ceiling, the planet settles", () => {
    for (const body of PLANETS) {
      const w = fakeWorld(body);
      const eco = w.sys.eco!;
      expect(eco, body).not.toBeNull();
      expect([...eco.groups.values()].some((g) => g.role === "grazer"), body).toBe(true);
      expect([...eco.groups.values()].some((g) => g.role === "predator"), body).toBe(true);
      const cells = eco.cells;
      let lowW = Infinity, lowP = Infinity;
      for (let t = 0; t < 12 * 3600; t += ECO.stepSeconds) {
        stepCells(cells, ECO.stepSeconds);
        if (t % 600 === 0) {
          for (const c of cells) {
            expect(inBounds(c), `${body} @${t}s`).toBe(true);
            lowW = Math.min(lowW, c.w / crowdK(c));
            lowP = Math.min(lowP, c.p / c.kp);
          }
        }
      }
      // Never empty for good: after the first hour nothing sits under the floor.
      expect(lowW, body).toBeGreaterThanOrEqual(ECO.floor - 1e-6);
      expect(lowP, body).toBeGreaterThanOrEqual(ECO.floor - 1e-6);
      // Settled: herds about three quarters full, packs nearly full (XP per hour holds, balance §).
      const W = cells.reduce((s, c) => s + c.w, 0) / cells.reduce((s, c) => s + c.k, 0);
      const P = cells.reduce((s, c) => s + c.p, 0) / cells.reduce((s, c) => s + c.kp, 0);
      expect(W, body).toBeGreaterThan(0.6);
      expect(W, body).toBeLessThan(1);
      expect(P, body).toBeGreaterThan(0.75);
      expect(P, body).toBeLessThanOrEqual(1.1);
      w.sys.dispose();
    }
  });

  it("clearing a cell's wolves gives it more woolbacks for a while; a herd wiped out comes back by breeding and wandering in", () => {
    const base = Array.from({ length: 60 }, (_, i) => newCell(i % 3 ? 4 : 12, i % 4 ? 1.5 : 8));
    for (let t = 0; t < 6 * 3600; t += ECO.stepSeconds) stepCells(base, ECO.stepSeconds);
    const a = clone(base), b = clone(base);
    a[0]!.p = 0; // the player cleared this cell's wolves
    for (let t = 0; t < 300; t += ECO.stepSeconds) {
      stepCells(a, ECO.stepSeconds);
      stepCells(b, ECO.stepSeconds);
    }
    expect(a[0]!.w).toBeGreaterThan(b[0]!.w * 1.1);
    // Wipe a herd: it is back over half its capacity within ten minutes, and not instantly.
    const c = clone(base);
    c[0]!.w = 0;
    stepCells(c, ECO.stepSeconds);
    expect(c[0]!.w).toBeLessThan(0.2 * c[0]!.k);
    for (let t = 0; t < 600; t += ECO.stepSeconds) stepCells(c, ECO.stepSeconds);
    expect(c[0]!.w).toBeGreaterThan(0.5 * c[0]!.k);
    // A grazed-bare cell recovers slower: its herd regrows slower than in a lush one.
    const lush = clone(base), bare = clone(base);
    lush[0]!.w = bare[0]!.w = 0.2 * base[0]!.k;
    bare[0]!.f = 0.05;
    for (let t = 0; t < 300; t += ECO.stepSeconds) {
      stepCells(lush, ECO.stepSeconds);
      stepCells(bare, ECO.stepSeconds);
    }
    expect(bare[0]!.w).toBeLessThan(lush[0]!.w);
  });

  it("a crowd raises a cell's capacity, so it doesn't run dry for everyone", () => {
    const one = [newCell(10, 4)], crowd = [newCell(10, 4)];
    crowd[0]!.crowd = 3;
    for (let t = 0; t < 3600; t += ECO.stepSeconds) {
      stepCells(one, ECO.stepSeconds);
      stepCells(crowd, ECO.stepSeconds);
    }
    expect(crowd[0]!.w).toBeGreaterThan(one[0]!.w * 1.3);
  });
});

/** A food-chain group of `role` and the world with a player standing `away` metres from it. */
function wake(w: FakeWorld, role: "grazer" | "predator", away: number) {
  const eco = w.sys.eco!;
  const g = w.sys.groups.find((x) => eco.roleOf(x.point.id) === role && eco.want(x.point.id) >= 2)!;
  const pt = g.point;
  const R = w.sys.ground.R;
  const pos: [number, number, number] = [pt.pos[0] + pt.t1[0] * away, pt.pos[1] + pt.t1[1] * away, pt.pos[2] + pt.t1[2] * away];
  const l = Math.hypot(...pos);
  const p = w.addPlayer("p", [(pos[0] / l) * (R + 2), (pos[1] / l) * (R + 2), (pos[2] / l) * (R + 2)], 20);
  for (let i = 0; i < 80 && !g.active; i++) w.step(50);
  for (let i = 0; i < 40; i++) w.step(50); // past the spawn-in
  return { g, p };
}

describe("food chain in the world (#15)", () => {
  it("a herd comes out only as full as its cell, and when killed off returns by walking in from nearby, not at its spot", () => {
    const w = fakeWorld("arcadia");
    const eco = w.sys.eco!;
    const { g, p } = wake(w, "grazer", 30);
    const cell = eco.groups.get(g.point.id)!.cell;
    const out = () => g.members.filter((m) => m && !m.dead);
    expect(out().length).toBe(eco.want(g.point.id));
    const homes = out().map((m) => [...m!.home]);
    const before = eco.cells[cell]!.w;
    // The player kills the whole herd.
    for (const m of out()) dealDamage(w.world.host, p, m!, 9999, false);
    w.step(50);
    expect(g.cleared).toBe(true);
    expect(eco.cells[cell]!.w).toBeLessThanOrEqual(Math.max(0, before - homes.length) + 0.01);
    expect(eco.counts.playerKills).toBeGreaterThanOrEqual(homes.length);
    // While the cell is near-empty the herd does not come back, however long the old timer was.
    eco.cells[cell]!.w = 0;
    eco.cells[cell]!.f = 0.6;
    const left = g.respawnLeft;
    for (let i = 0; i < 20; i++) w.step(500);
    expect(g.respawnLeft).toBeCloseTo(left, 5);
    // Once wanderers and births refill the cell it returns; the members appear ECO.arriveFrom off and walk home.
    eco.cells[cell]!.w = eco.cells[cell]!.k;
    g.respawnLeft = 1;
    for (let i = 0; i < 30 && !g.active; i++) w.step(250);
    expect(g.active).toBe(true);
    const back = out();
    expect(back.length).toBeGreaterThan(0);
    for (const m of back) {
      const d = Math.min(...homes.map((h) => Math.hypot(m!.pos[0] - h[0]!, m!.pos[1] - h[1]!, m!.pos[2] - h[2]!)));
      expect(d).toBeGreaterThan(ECO.arriveFrom * 0.6);
    }
    expect(eco.counts.returns).toBeGreaterThanOrEqual(1);
    w.sys.dispose();
  });

  it("Dusk Wolves hunt a Woolback on their own: the kill pays nobody and lowers the herd's count", () => {
    const w = fakeWorld("arcadia");
    const eco = w.sys.eco!;
    // Wake a pack with the player far enough off that the wolves can't see or hear them.
    const { g: pack, p } = wake(w, "predator", 120);
    const wolves = pack.members.filter((m) => m && !m.dead)!;
    expect(wolves.length).toBeGreaterThan(0);
    // A herd somewhere: wake it too, then walk one woolback over to the wolves.
    const herd = w.sys.groups.find((x) => eco.roleOf(x.point.id) === "grazer" && eco.want(x.point.id) >= 1)!;
    const second = w.addPlayer("q", [herd.point.pos[0] + herd.point.t1[0] * 120, herd.point.pos[1] + herd.point.t1[1] * 120, herd.point.pos[2] + herd.point.t1[2] * 120], 20);
    for (let i = 0; i < 120 && !herd.members.some((m) => m && !m.dead && m.mode !== MODE.SPAWN); i++) w.step(50);
    const prey = herd.members.find((m) => m && !m.dead)!;
    const wolf = wolves[0]!;
    prey.pos = [wolf.pos[0] + 12 * pack.point.t2[0], wolf.pos[1] + 12 * pack.point.t2[1], wolf.pos[2] + 12 * pack.point.t2[2]];
    prey.home = [...prey.pos];
    const cell = eco.groups.get(herd.point.id)!.cell;
    const wBefore = eco.cells[cell]!.w;
    const xpBefore = p.char.xp + second.char.xp;
    // Make sure the wolves are calm, then let them notice it (a long scan makes the hunt certain).
    for (const n of wolves) w.sys.setMode(n!, MODE.IDLE, w.clock.t, w.clock.t + 99_999);
    startHunts(w.sys, w.clock.t, 10_000);
    expect(wolves.some((n) => n!.hunt?.prey === prey.id)).toBe(true);
    for (let i = 0; i < 400 && !prey.dead; i++) w.step(50);
    expect(prey.dead).toBe(true);
    expect(eco.counts.predatorKills).toBe(1);
    expect(eco.cells[cell]!.w).toBeLessThan(wBefore - 0.9); // one fewer (births go on meanwhile)
    expect(p.char.xp + second.char.xp).toBe(xpBefore);
    w.sys.dispose();
  });

  it("the cell counts are saved with the copy and run on while it was empty", () => {
    const w = fakeWorld("arcadia");
    const eco = w.sys.eco!;
    eco.cells[0]!.w = 0;
    eco.cells[1]!.p = 0;
    const snap = eco.snapshot();
    const w2 = fakeWorld("arcadia");
    w2.sys.eco!.restore(snap, 0);
    expect(w2.sys.eco!.cells[0]!.w).toBe(0);
    expect(w2.sys.eco!.cells[1]!.p).toBe(0);
    // An hour away: the empty cell refilled from wanderers and births.
    w2.sys.eco!.restore(snap, 3600);
    expect(w2.sys.eco!.cells[0]!.w).toBeGreaterThan(ECO.floor * w2.sys.eco!.cells[0]!.k);
    // A save from another layout is ignored.
    const w3 = fakeWorld("arcadia");
    const fresh = w3.sys.eco!.snapshot();
    w3.sys.eco!.restore([1, 2, 3], 0);
    expect(w3.sys.eco!.snapshot()).toEqual(fresh);
    for (const x of [w, w2, w3]) x.sys.dispose();
  });

  it("the moon and Portus have no food chain", () => {
    expect(fakeWorld("lumen").sys.eco).toBeNull();
    expect(fakeWorld("portus").sys.eco).toBeNull();
  });
});

// Keep the NPC index import honest (the chain's species exist).
it("the chain's species are real NPC defs", () => {
  expect(NPC_INDEX.get("woolback")).toBeGreaterThanOrEqual(0);
  expect(NPC_INDEX.get("dusk_wolf")).toBeGreaterThanOrEqual(0);
});

// The Portus town's structures in the real movement path (D38, D39): a client walking into a house is
// corrected and never ends up inside it; walking the streets through a gatehouse and the castle gate
// is accepted without corrections; a save or a teleport inside a big building is placed clear of it
// by the server, so the real client controller starts where the server does (no correction loop,
// round-1 B1); stage formations never stand anyone inside a structure. Bots send positions like the
// real client (input packets every 50 ms), against the server the tests start in-process.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { offsetDir, placeDir } from "@firstlight/shared/content/places";
import { newCharacter } from "@firstlight/shared/content/character";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "@firstlight/shared/content/portusTown";
import { structureCollider, townCoords, townDir } from "@firstlight/shared/planet/town";
import { PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { characterRepo } from "../src/world/characters.ts";
import { formation, STAGES } from "../src/world/quests/stage.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import * as Q from "./quest-helpers.ts";

const R = BODIES.portus.radius;
const terrain = Q.terrain("portus");
const town = structureCollider(terrain)!;

/** Ground position at town point (east, north). */
const at = (east: number, north: number) => Q.ground("portus", townDir(east, north, R));
const inside = (p: { x: number; y: number; z: number }) => town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside;
const item = (name: string) => TOWN_LAYOUT.find((it) => TOWN_PREFABS[it[0]]!.name === name)!;

beforeAll(async () => {
  Q.harness.game = await startServer();
});
afterAll(async () => {
  for (const r of Q.harness.rooms.splice(0)) await safeLeave(r);
  await Q.harness.game!.close();
});

/** Wait until the server has replicated input `seq` (accepted, or refused and corrected). */
const processed = (b: Q.Bot, seq: number) => Q.until(`input ${seq} replicated`, () => (Q.me(b).seq ?? 0) >= seq);

/** Run along town points at 5 m/s (client packets every 50 ms); returns the corrections received. */
async function run(b: Q.Bot, path: readonly (readonly [number, number])[]): Promise<number> {
  let corrections = 0;
  const off = b.room.onMessage("correct", () => corrections++);
  let seq = (Q.me(b).seq ?? 0) + 100;
  for (let k = 0; k + 1 < path.length; k++) {
    const [ae, an] = path[k]!, [be, bn] = path[k + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(be - ae, bn - an) / 0.25));
    const fd = townDir(ae + (be - ae) * 0.01, an + (bn - an) * 0.01, R);
    for (let i = 1; i <= n; i++) {
      const p = at(ae + ((be - ae) * i) / n, an + ((bn - an) * i) / n);
      b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: fd[0], fy: fd[1], fz: fd[2], anim: 1, t: Date.now() });
      await Q.sleep(50); // client packet pacing
    }
  }
  await processed(b, seq);
  off();
  return corrections;
}

// ------------------------------------------------------------------------------------ the real client

interface Controller {
  pos: { x: number; y: number; z: number };
  facing: { x: number; y: number; z: number };
  anim: number;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
  correct(x: number, y: number, z: number): void;
  setStructures(c: unknown): void;
}

/** The client's PlayerController (apps/client), loaded at runtime so the server typecheck stays server-only. */
async function realController(): Promise<Controller> {
  const url = new URL("../../client/src/game/PlayerController.ts", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ url)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const pc = new PlayerController(terrain, BODIES.portus.waterLevel);
  pc.setStructures({ resolve: (p: { x: number; y: number; z: number }, out: never) => town.resolve(p, out) });
  return pc;
}

/** A standing player's input (no keys): the controller only settles and resolves. */
const idle = { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), keys: new Set<string>(), down: () => false };

/**
 * Drive the real controller like Game.frame does: teleport to the server's position, then 20 frames
 * at 20 Hz, each sending its position as an input packet; every server correction goes back into
 * PlayerController.correct. Returns the corrections and the final controller position.
 */
async function drive(b: Q.Bot): Promise<{ corrections: number; pc: Controller }> {
  const pc = await realController();
  const me = Q.me(b);
  pc.teleport(me.x, me.y, me.z);
  let corrections = 0;
  const off = b.room.onMessage("correct", (m: { x: number; y: number; z: number }) => {
    corrections++;
    pc.correct(m.x, m.y, m.z);
  });
  let seq = (me.seq ?? 0) + 100;
  for (let k = 0; k < 20; k++) {
    pc.update(0.05, idle, false);
    b.room.send("input", { seq: ++seq, x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, fx: pc.facing.x, fy: pc.facing.y, fz: pc.facing.z, anim: pc.anim, t: Date.now() });
    await Q.sleep(50); // client packet pacing
  }
  await processed(b, seq);
  off();
  return { corrections, pc };
}

describe("Portus town structures on the server (D38)", () => {
  it("refuses walking into a house: corrections, and the player never stands inside it", async () => {
    const b = await Q.bot("town_wall_walker", "portus");
    const house = TOWN_LAYOUT.find((it) => TOWN_PREFABS[it[0]]!.name === "house_c" && it[1] > 0)!; // east street, north side
    // From the street in front of its door, straight into it and on through.
    const front: [number, number] = [house[1], 0.6];
    await Q.tpAndWait(b, at(front[0], front[1]));
    const corrections = await run(b, [front, [house[1], house[2]], [house[1], house[2] + 6]]);
    expect(corrections).toBeGreaterThan(0);
    const p = Q.me(b);
    expect(inside(p)).toBe(false);
    const [, north] = townCoords(p.x, p.y, p.z, R);
    // Still on the street side of the house's front wall.
    expect(north).toBeLessThan(house[2] - 1.5);
  });

  it("accepts the east street out through the gatehouse and the castle street into the ward", async () => {
    const b = await Q.bot("town_gate_walker", "portus");
    const east = TOWN_STREETS.find((s) => s.name === "east")!.pts.slice(0, 6);
    await Q.tpAndWait(b, at(east[0]![0], east[0]![1]));
    expect(await run(b, east)).toBe(0);
    const end = east.at(-1)!;
    expect(Q.near(b, at(end[0], end[1]), 1)).toBe(true);
    // Back in and up castle street through the castle gate.
    await Q.tpAndWait(b, at(0, 19.5));
    expect(await run(b, [[0, 19.5], [0, 30], [0, 41], [0, 43.8]])).toBe(0);
    expect(Q.near(b, at(0, 43.8), 1)).toBe(true);
  });
});

describe("placing players clear of the town's buildings (round-1 B1)", () => {
  // The biggest footprints: the client's push-out from their centres (4–5.8 m) exceeds the move budget.
  for (const name of ["keep", "market_hall", "hall_of_firsts"]) {
    it(`a save at the ${name}'s centre joins outside it, and the real controller gets no correction loop`, async () => {
      const it_ = item(name);
      const userId = `town_saved_${name}`;
      const c = newCharacter(0, 0);
      c.body = "portus";
      c.pos = at(it_[1], it_[2]);
      expect(inside({ x: c.pos[0]!, y: c.pos[1]!, z: c.pos[2]! })).toBe(true);
      characterRepo.current.save(userId, c);
      const room = await joinAs(Q.harness.game!, userId, "portus");
      Q.harness.rooms.push(room);
      const me = () => (room.state as any).players?.get(room.sessionId);
      await waitFor(() => !!me());
      const b = { room, id: room.sessionId } as Q.Bot;
      // Placed on clear ground next to the building (the push the client would have made).
      const start = { x: me().x, y: me().y, z: me().z };
      expect(inside(start)).toBe(false);
      expect(Math.hypot(start.x - c.pos[0]!, start.y - c.pos[1]!, start.z - c.pos[2]!)).toBeLessThan(9);
      const { corrections, pc } = await drive(b);
      expect(corrections).toBe(0);
      expect(Math.hypot(pc.pos.x - me().x, pc.pos.y - me().y, pc.pos.z - me().z)).toBeLessThan(0.05);
      expect(inside(me())).toBe(false);
    });
  }

  it("an admin teleport into the keep lands outside it, and the controller agrees with the server", async () => {
    const b = await Q.bot("town_teleporter", "portus");
    const keep = item("keep");
    Q.tp(b, at(keep[1], keep[2]));
    await Q.until("teleported near the keep", () => Q.near(b, at(keep[1], keep[2]), 9) && !Q.near(b, at(0, 0), 20));
    expect(inside(Q.me(b))).toBe(false);
    const { corrections } = await drive(b);
    expect(corrections).toBe(0);
  });

  it("the Hall of Firsts board's stand is solid on the server too: a teleport onto it lands clear, walking through it is refused (S4)", async () => {
    const b = await Q.bot("town_board_tester", "portus");
    const [pe, pn] = TOWN_FIXED.plaque;
    const toward = [-pe / Math.hypot(pe, pn), -pn / Math.hypot(pe, pn)] as const;
    const front = (d: number) => [pe + toward[0] * d, pn + toward[1] * d] as [number, number];
    // Onto the stand: placed beside it, and the real controller starts where the server does.
    Q.tp(b, at(pe, pn));
    await Q.until("teleported by the board", () => Q.near(b, at(pe, pn), 6) && !Q.near(b, at(0, 0), 15));
    expect(inside(Q.me(b))).toBe(false);
    expect((await drive(b)).corrections).toBe(0);
    // From 2.5 m in front, straight through the board to 2.5 m behind it: refused and corrected,
    // never inside the stand, still on the plaza side.
    await Q.tpAndWait(b, at(...front(2.5)));
    expect(await run(b, [front(2.5), front(-2.5)])).toBeGreaterThan(0);
    const p = Q.me(b);
    expect(inside(p)).toBe(false);
    const [e, n] = townCoords(p.x, p.y, p.z, R);
    expect((e - pe) * toward[0] + (n - pn) * toward[1]).toBeGreaterThan(0.2);
  });

  it("stage formations in Portus put nobody inside a structure (every count up to 40)", async () => {
    const b = await Q.bot("town_stage_checker", "portus");
    const room = Q.serverRoom(b);
    for (const def of STAGES.filter((s) => s.body === "portus")) {
      const centre = offsetDir(placeDir(def.place), def.east ?? 0, def.north ?? 0, R);
      for (let count = 1; count <= 40; count++) {
        formation(def.formation, count).forEach(([e, n], i) => {
          const d = offsetDir(centre, e, n, R);
          const want = [d[0] * R, d[1] * R, d[2] * R];
          const p = room.placeBody(want, `stage${i}`);
          const q = { x: p[0], y: p[1], z: p[2] };
          expect(inside(q), `stage ${def.n}, ${count} players, slot ${i}`).toBe(false);
          expect(town.resolve({ ...q }, { pushed: false, nx: 0, ny: 0, nz: 0, floor: 0 }), `slot ${i} still overlapping`).toBe(false);
          // The shape holds: a slot touching a prop moves at most a body's width.
          const g = Q.ground("portus", d);
          expect(Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2])).toBeLessThan(1.2);
        });
      }
    }
  });
});

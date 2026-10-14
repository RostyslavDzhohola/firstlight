// The Portus town's structures in the real movement path (D38): a client walking into a house is
// corrected and never ends up inside it; walking the streets through a gatehouse and the castle
// gate is accepted without corrections. Bots send positions like the real client (input packets
// every 50 ms at running speed), against the server the tests start in-process.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "@firstlight/shared/content/portusTown";
import { structureCollider, townCoords, townDir } from "@firstlight/shared/planet/town";
import { PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { safeLeave, startServer } from "./helpers.ts";
import * as Q from "./quest-helpers.ts";

const R = BODIES.portus.radius;
const town = structureCollider(Q.terrain("portus"))!;

/** Ground position at town point (east, north). */
const at = (east: number, north: number) => Q.ground("portus", townDir(east, north, R));

beforeAll(async () => {
  Q.harness.game = await startServer();
});
afterAll(async () => {
  for (const r of Q.harness.rooms.splice(0)) await safeLeave(r);
  await Q.harness.game!.close();
});

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
      await Q.sleep(50);
    }
  }
  await Q.sleep(300);
  off();
  return corrections;
}

describe("Portus town structures on the server (D38)", () => {
  it("refuses walking into a house: corrections, and the player never stands inside it", async () => {
    const b = await Q.bot("town_wall_walker", "portus");
    const house = TOWN_LAYOUT.find((it) => TOWN_PREFABS[it[0]]!.name === "house_c" && it[1] > 0)!; // east street, north side
    // From the street in front of its door, straight into it and on through.
    const front: [number, number] = [house[1], 0.6];
    await Q.tpAndWait(b, at(front[0], front[1]));
    await Q.sleep(300);
    const corrections = await run(b, [front, [house[1], house[2]], [house[1], house[2] + 6]]);
    expect(corrections).toBeGreaterThan(0);
    const p = Q.me(b);
    expect(town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside).toBe(false);
    const [, north] = townCoords(p.x, p.y, p.z, R);
    // Still on the street side of the house's front wall.
    expect(north).toBeLessThan(house[2] - 1.5);
  });

  it("accepts the east street out through the gatehouse and the castle street into the ward", async () => {
    const b = await Q.bot("town_gate_walker", "portus");
    const east = TOWN_STREETS.find((s) => s.name === "east")!.pts.slice(0, 6);
    await Q.tpAndWait(b, at(east[0]![0], east[0]![1]));
    await Q.sleep(300);
    expect(await run(b, east)).toBe(0);
    const end = east.at(-1)!;
    expect(Q.near(b, at(end[0], end[1]), 1)).toBe(true);
    // Back in and up castle street through the castle gate.
    await Q.tpAndWait(b, at(0, 19.5));
    await Q.sleep(300);
    expect(await run(b, [[0, 19.5], [0, 30], [0, 41], [0, 43.8]])).toBe(0);
    expect(Q.near(b, at(0, 43.8), 1)).toBe(true);
  });
});

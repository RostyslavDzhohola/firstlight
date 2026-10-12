// Seam 1: standing inside a breakable prop is no shield (F12 Opus addendum to Codex S4): rays that
// start inside a prop ignore it, and a shot reaching a player who stands inside the prop that
// stopped it still hits them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, createTerrain, isSafe, type Breakable } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { rayTerrain, type V3 } from "../src/world/geometry.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const BODY = "hollowmere" as const;
const terrain = createTerrain(BODY);
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const up = (p: V3): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
};
const add = (p: V3, d: V3, k: number): V3 => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const dirTo = (a: V3, b: V3): V3 => {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};
function ground(p: V3): V3 {
  const l = Math.hypot(p[0], p[1], p[2]);
  const r = BODIES[BODY].radius + terrain.groundHeight(p[0] / l, p[1] / l, p[2] / l) + 0.02;
  return [(p[0] / l) * r, (p[1] / l) * r, (p[2] / l) * r];
}
const head = (feet: V3) => add(feet, up(feet), 1.6);
const chest = (feet: V3) => add(feet, up(feet), 1.1);

function destruction(r: Room): DestructionSystem {
  const room = matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
  return room.systems.find((s) => s instanceof DestructionSystem) as DestructionSystem;
}

/** A pillar (4.2 m tall) a player can stand in, with a clear line from a spot `range` m away. */
function findPillar(sys: DestructionSystem, range: number): { b: Breakable; inside: V3; outside: V3 } {
  for (const b of sys.list) {
    if (b.kind !== "pillar") continue;
    const inside = ground([b.px, b.py, b.pz]);
    if (isSafe(BODIES[BODY], inside[0], inside[1], inside[2])) continue;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const outside = ground([b.px + (b.rx * c + b.fx * s) * range, b.py + (b.ry * c + b.fy * s) * range, b.pz + (b.rz * c + b.fz * s) * range]);
      if (isSafe(BODIES[BODY], outside[0], outside[1], outside[2])) continue;
      const h = Math.hypot(...outside) - BODIES[BODY].radius;
      if (h < BODIES[BODY].waterLevel + 0.4) continue;
      // The pillar must be the only thing between the two chests.
      const o = head(outside), aim = chest(inside);
      const d = dirTo(o, aim);
      const len = Math.hypot(aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]);
      if (rayTerrain(terrain, o, d, len, 0.5) <= len) continue;
      const hit = sys.raycast(o, d, len);
      if (!hit || hit.index !== b.index) continue;
      return { b, inside, outside };
    }
  }
  throw new Error("no pillar with a clear line");
}

async function placeAt(r: Room, p: V3) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
  await waitFor(() => Math.hypot(me(r).x - p[0], me(r).y - p[1], me(r).z - p[2]) < 0.3 && !(me(r).flags & 3));
}

function shoot(r: Room, from: V3, at: V3) {
  const o = head(from);
  const d = dirTo(o, at);
  r.send("scope", { on: true });
  r.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], t: Date.now() });
}

describe("no hiding inside props", () => {
  it("a player standing inside a pillar can be shot, and can shoot out", async () => {
    const out = await joinAs(game, "outsider", BODY, { starter: 3 }, "admin");
    const hid = await joinAs(game, "hider", BODY, { starter: 3 }, "admin");
    rooms.push(out, hid);
    await waitFor(() => !!me(out) && !!me(hid));
    const sys = destruction(out);
    const { inside, outside } = findPillar(sys, 8);
    await placeAt(out, outside);
    await placeAt(hid, inside);
    await new Promise((ok) => setTimeout(ok, 300));

    const hidHp = me(hid).hp;
    shoot(out, outside, chest(inside));
    await waitFor(() => me(hid).hp < hidHp, 3000);

    await new Promise((ok) => setTimeout(ok, 600)); // carbine rate
    const outHp = me(out).hp;
    shoot(hid, inside, chest(outside));
    await waitFor(() => me(out).hp < outHp, 3000);
    expect(me(out).hp).toBeLessThan(outHp);
  });
});

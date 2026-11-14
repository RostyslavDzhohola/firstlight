// The three families appended on 2026-11-13 (Winged Boarspear, Windlass Crossbow, Shepherd's Lantern):
// each one, given and selected, lands on a creature outside a pad ring on the real message path
// (melee or fire, as the client sends them), and the Lantern's light passes through a line of two.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { flat, me, offset, openSpotOutside, place, serverRoom, spawnNpc, st, type V } from "./npc-bots.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const up = (p: readonly number[]): V => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return [p[0]! / l, p[1]! / l, p[2]! / l];
};
const norm = (v: readonly number[]): V => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const pos = (r: Room): V => [me(r).x, me(r).y, me(r).z];

let seq = 5000;
async function standFacing(r: Room, at: V, toward: V) {
  place(r, at);
  await waitFor(() => flat(pos(r), at) < 1.5 && !(me(r).flags & PF.PROTECTED));
  const p = pos(r);
  const u = up(p);
  const v = [toward[0] - p[0], toward[1] - p[1], toward[2] - p[2]];
  const k = v[0]! * u[0] + v[1]! * u[1] + v[2]! * u[2];
  const f = norm([v[0]! - k * u[0], v[1]! - k * u[1], v[2]! - k * u[2]]);
  r.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: f[0], fy: f[1], fz: f[2], anim: 0, t: Date.now() });
  await waitFor(() => Math.abs(me(r).fx - f[0]) < 1e-3 && Math.abs(me(r).fz - f[2]) < 1e-3);
}

function aimAt(r: Room, npc: { x: number; y: number; z: number }) {
  const p = pos(r);
  const head: V = [p[0] + up(p)[0] * 1.6, p[1] + up(p)[1] * 1.6, p[2] + up(p)[2] * 1.6];
  const n = up([npc.x, npc.y, npc.z]);
  const chest = [npc.x + n[0] * 0.7, npc.y + n[1] * 0.7, npc.z + n[2] * 0.7];
  const d = norm([chest[0]! - head[0], chest[1]! - head[1], chest[2]! - head[2]]);
  return { ox: head[0], oy: head[1], oz: head[2], dx: d[0], dy: d[1], dz: d[2] };
}

async function armed(id: string) {
  const r = await joinAs(game, `w-${id}`, "arcadia", { starter: 3 }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  const denied: string[] = [];
  r.onMessage("denied", (m: { reason: string }) => denied.push(m.reason));
  const hits: string[] = [];
  r.onMessage("hit", (m: { attacker: string; target: string }) => {
    if (m.attacker === r.sessionId) hits.push(m.target);
  });
  for (const t of ["you", "toast", "shot", "projectile", "explode", "swing", "npcInfo", "immune", "npcKill"]) r.onMessage(t, () => {});
  r.send("admin", { cmd: "give", args: { id, tier: 1, qty: 1 } });
  const actor = () => serverRoom(r).actors.get(r.sessionId)!;
  await waitFor(() => actor().char.hotbar.some((it: { id: string } | null) => it?.id === id));
  const slot = actor().char.hotbar.findIndex((it: { id: string } | null) => it?.id === id);
  return { r, denied, hits, slot };
}

describe("the 2026-11-13 weapon families on the real message path", () => {
  for (const [id, ranged, dist] of [["boarspear", false, 2.8], ["crossbow", true, 12], ["lantern", true, 10]] as const) {
    it(`${id} lands on a creature ${dist} m ahead`, async () => {
      const { r, denied, hits, slot } = await armed(id);
      const outside = openSpotOutside("arcadia", 14);
      const target = offset(outside, dist, 0, BODIES.arcadia.radius);
      await standFacing(r, outside, target);
      const npc = await spawnNpc(r, "woolback", target, { instant: true, roam: 0 });
      await waitFor(() => !!st(r).npcs?.get(npc));
      const hp = st(r).npcs.get(npc).hp;
      if (ranged) r.send("fire", { slot, ...aimAt(r, st(r).npcs.get(npc)), t: Date.now() });
      else r.send("melee", { slot, t: Date.now(), heavy: false });
      await waitFor(() => hits.includes(npc) || denied.length > 0);
      expect(denied).toEqual([]);
      await waitFor(() => st(r).npcs.get(npc)?.hp < hp);
      expect(me(r).weapon).toBeGreaterThan(21); // one of the appended families is in hand
    });
  }

  it("a Shepherd's Lantern light passes through the first creature into the one behind it (pierce)", async () => {
    const { r, denied, hits, slot } = await armed("lantern");
    const outside = openSpotOutside("arcadia", 14);
    const near = offset(outside, 6, 0, BODIES.arcadia.radius);
    const far = offset(outside, 11, 0, BODIES.arcadia.radius);
    await standFacing(r, outside, far);
    const a = await spawnNpc(r, "woolback", near, { instant: true, roam: 0 });
    const b = await spawnNpc(r, "woolback", far, { instant: true, roam: 0 });
    await waitFor(() => !!st(r).npcs?.get(a) && !!st(r).npcs?.get(b));
    r.send("fire", { slot, ...aimAt(r, st(r).npcs.get(b)), t: Date.now() });
    await waitFor(() => (hits.includes(a) && hits.includes(b)) || denied.length > 0, 8000);
    expect(denied).toEqual([]);
  });
});

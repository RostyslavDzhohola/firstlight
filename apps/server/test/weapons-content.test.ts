// Weapon details from the content.md §2.3 table that the F12 review found missing: the Riverstaff
// knocks back on every 3rd hit in a row (not every hit), Emberglass burn also burns NPCs, and the
// Scrapburst fuse shortens by tier. Socket-free: the real combat code on a fake world.

import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import type { PlayerActor } from "../src/world/actors.ts";
import { fire, melee, projectiles, stepEffects, stepProjectiles } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

/** Ground point `along` metres from Arcadia's main pad on a fixed tangent; also returns that tangent. */
function pt(w: FakeWorld, along: number): V3 {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const t = tangent();
  const v = [0, 1, 2].map((i) => d[i]! + (t[i]! * along) / R);
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return w.world.snapToGround([(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R]);
}
function tangent(): V3 {
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  return [t[0]! / tl, t[1]! / tl, t[2]! / tl];
}
const lift = (p: V3, h: number): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] + (p[0] / l) * h, p[1] + (p[1] / l) * h, p[2] + (p[2] / l) * h];
};

function armed(w: FakeWorld, id: string, at: V3, tier: 1 | 2 | 3 = 1, level = 1): PlayerActor {
  const p = w.addPlayer("me", at, level);
  p.char.hotbar[0] = { id, tier, qty: WEAPON_BY_ID.get(id)!.stack };
  p.char.selected = 0;
  const f = tangent();
  p.state.fx = f[0];
  p.state.fy = f[1];
  p.state.fz = f[2];
  return p;
}

describe("Riverstaff", () => {
  it("knocks back on every 3rd hit in a row; a miss restarts the count", () => {
    const w = fakeWorld("arcadia");
    const p = armed(w, "riverstaff", pt(w, 80));
    const t = w.addPlayer("dummy", pt(w, 82), 20);
    const swing = () => {
      p.lastAttackAt = 0;
      w.clock.t += 400;
      melee(w.world.host, p, false);
    };
    const kbs = () => w.sent.filter((m) => m.to === p.id && m.type === "hit").map((m) => (m.msg as { kb: number }).kb);
    for (let i = 0; i < 6; i++) swing();
    expect(kbs()).toEqual([0, 0, 3, 0, 0, 3]);
    swing(); // 1
    w.movePlayer(t, pt(w, 95));
    swing(); // miss
    w.movePlayer(t, pt(w, 82));
    swing();
    swing();
    expect(kbs().slice(6)).toEqual([0, 0, 0]);
    swing();
    expect(kbs().at(-1)).toBe(3);
  });
});

describe("Emberglass", () => {
  it("a direct hit sets an NPC burning: 4/s for 3 s, refreshed, not stacked", () => {
    const w = fakeWorld("arcadia");
    const p = armed(w, "emberglass", pt(w, 80));
    const golem = w.sys.createNpc(NPC_INDEX.get("cabinet_golem")!, 6, pt(w, 90), w.clock.t, { instant: true });
    const head = lift(pt(w, 80), 1.6);
    const aim = lift(pt(w, 90), 1.5);
    const d = [aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    expect(fire(w.world.host, p, { ox: head[0], oy: head[1], oz: head[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l })).toEqual({ ok: true });
    const full = golem.state.hp;
    for (let i = 0; i < 30 && projectiles(w.world.host).length; i++) {
      w.clock.t += 50;
      stepProjectiles(w.world.host, 0.05);
    }
    const afterHit = golem.state.hp;
    expect(afterHit).toBeLessThan(full);
    for (let i = 0; i < 80; i++) {
      w.clock.t += 50;
      stepEffects(w.world.host, 0.05);
    }
    expect(afterHit - golem.state.hp).toBe(12);
  });
});

describe("Scrapburst Grenade", () => {
  it("fuses in 1.6 / 1.5 / 1.4 s by tier", () => {
    for (const [tier, fuse] of [[1, 1600], [2, 1500], [3, 1400]] as const) {
      const w = fakeWorld("arcadia");
      const p = armed(w, "grenade", pt(w, 80), tier, 12);
      const head = lift(pt(w, 80), 1.6);
      const f = tangent();
      expect(fire(w.world.host, p, { ox: head[0], oy: head[1], oz: head[2], dx: f[0], dy: f[1], dz: f[2] })).toEqual({ ok: true });
      expect(projectiles(w.world.host).at(-1)!.fuseAt! - w.clock.t).toBe(fuse);
    }
  });
});

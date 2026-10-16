// A hit that lands and deals nothing tells the attacker why (ServerMessages `immune`): the NPC's
// mitigation names the cause. Codex review: every unflagged zero used to be called a shield, so a
// player shooting a boss from outside its empty arena was told to hit it from the side or back.
// Socket-free: the real combat and NPC code on a fake world; the attacker's client records sends.

import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { NF, NPC_INDEX } from "@firstlight/shared/content/npcs";
import type { NpcActor, PlayerActor } from "../src/world/actors.ts";
import { dealDamage } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

function point(body: "arcadia" | "meridian", metres: number): V3 {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[0]!;
  const v = [d[0], d[1], d[2] + metres / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

/** A player whose client records what the server sends it. */
function attacker(w: FakeWorld, at: V3): { p: PlayerActor; immune: { target: string; reason: string }[] } {
  const p = w.addPlayer("me", at, 20);
  const immune: { target: string; reason: string }[] = [];
  (p as unknown as { client: unknown }).client = { send: (type: string, msg: { target: string; reason: string }) => type === "immune" && immune.push(msg) };
  return { p, immune };
}

/** Hit `n` for 30 from `from` (the direction the blow comes from decides shields). */
function hit(w: FakeWorld, p: PlayerActor, n: NpcActor, from: V3): boolean {
  return dealDamage(w.world.host, p, n, 30, false, [from[0] - n.state.x, from[1] - n.state.y, from[2] - n.state.z]);
}

describe("immune: why a hit did nothing", () => {
  it("spawning, evading and other invulnerable states name themselves", () => {
    const w = fakeWorld("arcadia");
    const { p, immune } = attacker(w, point("arcadia", 80));
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, point("arcadia", 90), w.clock.t, { instant: true });
    const cases: [number, string][] = [
      [NF.SPAWNING | NF.INVULN, "spawning"],
      [NF.EVADING | NF.INVULN, "evading"],
      [NF.INVULN, "invulnerable"],
    ];
    for (const [flags, reason] of cases) {
      n.state.flags = flags;
      expect(hit(w, p, n, point("arcadia", 80))).toBe(false);
      expect(immune.at(-1)).toEqual({ target: n.id, reason });
    }
    n.state.flags = 0;
    expect(hit(w, p, n, point("arcadia", 80))).toBe(true);
    expect(immune).toHaveLength(3);
  });

  it("a shield hit (also the one that breaks it) says shield; from behind it takes damage", () => {
    const w = fakeWorld("meridian");
    const { p, immune } = attacker(w, point("meridian", 80));
    const n = w.sys.createNpc(NPC_INDEX.get("enforcer")!, 13, point("meridian", 90), w.clock.t, { instant: true });
    n.state.flags &= ~(NF.SPAWNING | NF.INVULN);
    const f = (n as unknown as { facing: V3 }).facing;
    const front: V3 = [n.state.x + f[0] * 5, n.state.y + f[1] * 5, n.state.z + f[2] * 5];
    const back: V3 = [n.state.x - f[0] * 5, n.state.y - f[1] * 5, n.state.z - f[2] * 5];
    const hp = n.state.hp;
    for (let i = 0; i < 3; i++) expect(hit(w, p, n, front)).toBe(false); // 30 + 30 + 30 > a 70 shield
    expect(immune.map((m) => m.reason)).toEqual(["shield", "shield", "shield"]);
    expect(n.state.hp).toBe(hp);
    expect(hit(w, p, n, back)).toBe(true);
    expect(n.state.hp).toBeLessThan(hp);
  });

  it("a boss hit from outside its empty arena says arena, not shield", () => {
    const w = fakeWorld("arcadia");
    const boss = w.sys.boss!;
    boss.forceSpawn(w.clock.t);
    const n = boss.npc!;
    n.state.flags &= ~(NF.SPAWNING | NF.INVULN); // past the 1 s materialise
    // 120 m from the boss, far outside its arena (nobody inside): no damage, and the reason is the arena.
    const R = BODIES.arcadia.radius;
    const away: V3 = [n.pos[0], n.pos[1], n.pos[2] + 120];
    const l = Math.hypot(...away);
    const outside: V3 = [(away[0] / l) * R, (away[1] / l) * R, (away[2] / l) * R];
    const { p, immune } = attacker(w, outside);
    expect(hit(w, p, n as unknown as NpcActor, outside)).toBe(false);
    expect(immune).toEqual([{ target: n.id, reason: "arena" }]);
  });

  it("an NPC whose mitigation gives no reason is 'can't be hurt right now', not a shield", () => {
    const w = fakeWorld("arcadia");
    const { p, immune } = attacker(w, point("arcadia", 80));
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, point("arcadia", 90), w.clock.t, { instant: true });
    n.state.flags = 0;
    n.mitigate = () => 0; // some future rule that forgets to say why
    expect(hit(w, p, n, point("arcadia", 80))).toBe(false);
    expect(immune).toEqual([{ target: n.id, reason: "invulnerable" }]);
  });
});

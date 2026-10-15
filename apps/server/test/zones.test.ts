// Safe zones on the real path (D-zones-1, D-zones-2): Portus town is safe and the land outside its
// walls is wild, with creeps; every starter's weapon is refused inside a safe zone and accepted
// outside it on every body; NPCs never walk into the town; creeps are in view on arrival.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, nearSafeZone, padDirs, tangentFrame, zoneAt, type BodyId } from "@firstlight/shared";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { NF, NPC_DEFS, NPC_RULES } from "@firstlight/shared/content/npcs";
import { STARTERS, WEAPON_BY_ID, WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
  resetTuning();
});

type V = [number, number, number];
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const pos = (s: { x: number; y: number; z: number }): V => [s.x, s.y, s.z];
const d3 = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const R_PORTUS = BODIES.portus.radius;
/** Metres between two points' spots on the ground (heights ignored). */
const flatM = (a: V, b: V) => {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  return Math.hypot(a[0] / la - b[0] / lb, a[1] / la - b[1] / lb, a[2] / la - b[2] / lb) * R_PORTUS;
};

/** Portus town coordinates (east, north: metres from the pole, D38) → planet space at the radius. */
function town(east: number, north: number): V {
  const d = townDir(east, north, R_PORTUS);
  return [d[0] * R_PORTUS, d[1] * R_PORTUS, d[2] * R_PORTUS];
}

/** `metres` from pad 0 toward where the arrival camera looks (dry ground on every planet), at the radius. */
function ahead(body: BodyId, metres: number): V {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[0]!;
  const { fwd } = tangentFrame([d[0], d[1], d[2]]);
  const v = [d[0] + (fwd[0] * metres) / R, d[1] + (fwd[1] * metres) / R, d[2] + (fwd[2] * metres) / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

async function join(name: string, body: BodyId, starter: number): Promise<Room> {
  const r = await joinAs(game, name, body, { starter }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}

function teleport(r: Room, p: V) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
}

/** A `fire` message from the head toward a point (the camera's origin may sit up to 7 m back). */
function shotAt(r: Room, target: V) {
  const s = me(r);
  const l = Math.hypot(s.x, s.y, s.z);
  const o: V = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
  const d: V = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
  const dl = Math.hypot(...d);
  return { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0] / dl, dy: d[1] / dl, dz: d[2] / dl, t: Date.now() };
}

/** Somewhere 10 m ahead along the ground, a little up: a harmless aim point. */
function ahead10(r: Room): V {
  const s = me(r);
  const p: V = [s.x, s.y, s.z];
  const l = Math.hypot(...p);
  const { fwd } = tangentFrame([p[0] / l, p[1] / l, p[2] / l]);
  return [p[0] + fwd[0] * 10 + (p[0] / l) * 1.5, p[1] + fwd[1] * 10 + (p[1] / l) * 1.5, p[2] + fwd[2] * 10 + (p[2] / l) * 1.5];
}

/** Attack once with the starter weapon in slot 0; resolves with the server's answer. */
async function attack(r: Room, weapon: string): Promise<{ ok: true; via: string } | { ok: false; reason: string }> {
  const def = WEAPON_BY_ID.get(weapon)!;
  return new Promise((resolve) => {
    const offs: (() => void)[] = [];
    const done = (v: { ok: true; via: string } | { ok: false; reason: string }) => {
      for (const o of offs) o();
      resolve(v);
    };
    offs.push(r.onMessage("denied", (m: { action: string; reason: string }) => done({ ok: false, reason: m.reason })));
    for (const via of ["projectile", "shot", "swing"]) offs.push(r.onMessage(via, (m: { by: string }) => m.by === r.sessionId && done({ ok: true, via })));
    if (def.delivery === "melee") r.send("melee", { slot: 0, t: Date.now(), heavy: false });
    else r.send("fire", shotAt(r, ahead10(r)));
    setTimeout(() => done({ ok: false, reason: "no answer" }), 3000);
  });
}

describe("Portus: the castle town is safe, outside the walls is wild (D-zones-1)", () => {
  it("the server's SAFE flag matches the shared zone everywhere a player can stand", async () => {
    const r = await join("zoner", "portus", 0);
    const spots: [number, number][] = [[0, 0], [10, -5], [-20, -12], [30, 5], [44, 0], [0, 60], [-9, 50], [52, 0], [-52, 1], [0, -60], [70, 30], [-90, -80], [140, 0]];
    for (const [e, n] of spots) {
      const want = town(e, n);
      const expectSafe = zoneAt(BODIES.portus, ...want).safe;
      teleport(r, want);
      // Arrived there AND the server's flag says what the shared zone says (it times out otherwise).
      await waitFor(() => flatM(pos(me(r)), want) < 3 && !!(me(r).flags & PF.SAFE) === expectSafe).catch(() => {
        throw new Error(`at ${e}, ${n}: ${flatM(pos(me(r)), want).toFixed(1)} m off, flag ${me(r).flags & PF.SAFE}, zone ${expectSafe}`);
      });
      const z = zoneAt(BODIES.portus, ...pos(me(r)));
      expect(z.safe, `at ${e}, ${n}`).toBe(expectSafe);
      expect(z.kind, `at ${e}, ${n}`).toBe(Math.hypot(e, n) <= 46 || (Math.abs(e) <= 16 && n <= 64 && n >= 0) ? "town" : "wild");
    }
  });

  it("Hexwick's Hexquill I is refused in the town, fires outside the walls, and kills a Hopbit for XP", async () => {
    NPC_TUNING.ambient = true;
    const r = await join("hexwick", "portus", 0);
    let you: any = null;
    r.onMessage("you", (m) => (you = m));
    const fired: number[] = [];
    r.onMessage("projectile", (m: { by: string; weapon: number }) => m.by === r.sessionId && fired.push(m.weapon));
    await waitFor(() => !!(me(r).flags & PF.SAFE));
    expect(await attack(r, "hexquill")).toEqual({ ok: false, reason: "safe zone" });

    // Out through the east gate: wild land. The first 5 s after arriving are protected (refused as
    // "protected", which the client now says out loud), then the shot flies.
    const out = town(56, -4);
    r.send("admin", { cmd: "teleport", args: { x: out[0], y: out[1], z: out[2] } });
    await waitFor(() => !(me(r).flags & PF.SAFE));
    expect(await attack(r, "hexquill")).toEqual({ ok: false, reason: "protected" });
    r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(r).flags & PF.PROTECTED));
    expect(await attack(r, "hexquill")).toEqual({ ok: true, via: "projectile" });
    expect(fired).toEqual([WEAPON_INDEX.get("hexquill")]); // the starter's own Hexquill I, slot 0

    // The east gate's Hopbits are in view (the client gets NPCs within 80 m).
    const hopbit = () => {
      let best: { id: string; p: V } | null = null;
      st(r).npcs?.forEach((n: any, id: string) => {
        if (NPC_DEFS[n.kind]?.id !== "hopbit" || n.hp <= 0) return;
        const p: V = [n.x, n.y, n.z];
        if (!best || d3(p, pos(me(r))) < d3(best.p, pos(me(r)))) best = { id, p };
      });
      return best as { id: string; p: V } | null;
    };
    await waitFor(() => hopbit() !== null && d3(hopbit()!.p, pos(me(r))) < 40, 10_000);
    const xp0 = you?.xp ?? 0;
    const kills: any[] = [];
    r.onMessage("npcKill", (m) => kills.push(m));
    // Walk up (teleport) to 9 m from it and shoot until one dies.
    const h = hopbit()!;
    const l = Math.hypot(...h.p);
    const back = tangentFrame([h.p[0] / l, h.p[1] / l, h.p[2] / l]).fwd;
    teleport(r, [h.p[0] - back[0] * 9, h.p[1] - back[1] * 9, h.p[2] - back[2] * 9]);
    await new Promise((ok) => setTimeout(ok, 150));
    const t0 = Date.now();
    while (!kills.length && Date.now() - t0 < 15_000) {
      const t = hopbit();
      if (t) {
        const tl = Math.hypot(...t.p);
        r.send("fire", shotAt(r, [t.p[0] + (t.p[0] / tl) * 0.45, t.p[1] + (t.p[1] / tl) * 0.45, t.p[2] + (t.p[2] / tl) * 0.45]));
      }
      await new Promise((ok) => setTimeout(ok, 450));
    }
    expect(kills.length).toBeGreaterThan(0);
    expect(NPC_DEFS[kills[0].kind]!.id).toBe("hopbit");
    expect(kills[0].xp).toBeGreaterThan(0);
    await waitFor(() => !!you && (you.xp > xp0 || you.level > 1));
  }, 40_000);

  it("NPCs never walk into the town: Hopbits chasing a tagged player to the east gate stop outside and give up at once", async () => {
    NPC_TUNING.ambient = true;
    const r = await join("bait", "portus", 0);
    teleport(r, town(76, -15)); // ~11 m from the east gate's Hopbits
    await waitFor(() => !(me(r).flags & PF.SAFE));
    const hostiles = () => {
      const out: { id: string; p: V; flags: number }[] = [];
      st(r).npcs?.forEach((n: any, id: string) => NPC_DEFS[n.kind]?.temper === "hostile" && n.hp > 0 && out.push({ id, p: [n.x, n.y, n.z], flags: n.flags }));
      return out;
    };
    await waitFor(() => hostiles().length > 0, 10_000);
    // Shoot at one (they hear it; the combat tag keeps us fair game for 10 s), then run in through the gate.
    const t = hostiles().sort((a, b) => d3(a.p, pos(me(r))) - d3(b.p, pos(me(r))))[0]!;
    r.send("fire", shotAt(r, t.p));
    await waitFor(() => !!(me(r).flags & PF.IN_COMBAT));
    await waitFor(() => hostiles().some((n) => n.flags & NF.AGGRO), 10_000);
    // Lead them to the gate: wait just outside it until one is on us.
    const gate = town(52, -2);
    r.send("admin", { cmd: "teleport", args: { x: gate[0], y: gate[1], z: gate[2] } });
    await waitFor(() => d3(pos(me(r)), gate) < 3 && hostiles().some((n) => d3(n.p, pos(me(r))) < 7), 15_000);
    const near = hostiles().sort((a, b) => d3(a.p, pos(me(r))) - d3(b.p, pos(me(r))))[0]!;
    r.send("fire", shotAt(r, near.p)); // a fresh 10 s tag for the run in
    await new Promise((ok) => setTimeout(ok, 100));
    teleport(r, town(43.5, 0));
    let hpInside = 0;
    await waitFor(() => zoneAt(BODIES.portus, ...pos(me(r))).safe);
    // Still combat-tagged, but inside the walls: protected at once (D-zones-3).
    await waitFor(() => !!(me(r).flags & PF.SAFE));
    expect(me(r).flags & PF.IN_COMBAT).toBeTruthy();
    hpInside = me(r).hp;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      for (const n of hostiles()) {
        expect(zoneAt(BODIES.portus, ...n.p).safe).toBe(false);
        expect(nearSafeZone(BODIES.portus, ...n.p, NPC_RULES.safeMargin)).toBe(false);
      }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    // They were on us at the gate (above), and gave us up: nobody hunts a player inside the walls.
    expect(hostiles().every((n) => !(n.flags & NF.AGGRO))).toBe(true);
    expect(me(r).hp).toBe(hpInside);
  }, 30_000);

  it("creeps are in view from both gates: a herd close by and a weak pack to walk to (levels 1–2)", async () => {
    NPC_TUNING.ambient = true;
    const r = await join("looker", "portus", 3);
    for (const e of [50, -50]) {
      teleport(r, town(e, 0));
      const seen = () => {
        const out = { hostile: 0, calm: 0, maxLevel: 0 };
        st(r).npcs?.forEach((n: any) => {
          if (n.hp <= 0) return;
          out.maxLevel = Math.max(out.maxLevel, n.level);
          const d = d3([n.x, n.y, n.z], pos(me(r)));
          if (NPC_DEFS[n.kind]!.temper === "hostile") out.hostile += d <= 60 ? 1 : 0;
          else out.calm += d <= 40 ? 1 : 0;
        });
        return out;
      };
      await waitFor(() => seen().hostile > 0 && seen().calm > 0, 10_000);
      expect(seen().maxLevel).toBeLessThanOrEqual(2);
    }
  }, 30_000);
});

describe("every starter's weapon on every body: refused in a safe zone, fired outside (item 2)", () => {
  const OUTSIDE: Record<BodyId, () => V> = {
    portus: () => town(56, -4),
    arcadia: () => ahead("arcadia", 30),
    hollowmere: () => ahead("hollowmere", 30),
    meridian: () => ahead("meridian", 30),
  };
  for (const body of ["portus", "arcadia", "hollowmere", "meridian"] as const) {
    it(`${body}: Hexwick, Brother Ash, Kappa and Unit 7`, async () => {
      for (const [i, s] of STARTERS.entries()) {
        const r = await join(`${s.id}-${body}`, body, i);
        r.send("admin", { cmd: "unprotect" });
        await waitFor(() => !(me(r).flags & PF.PROTECTED) && !!(me(r).flags & PF.SAFE));
        expect(await attack(r, s.weapon), `${s.name} in the ${body} safe zone`).toEqual({ ok: false, reason: "safe zone" });
        teleport(r, OUTSIDE[body]());
        await waitFor(() => !(me(r).flags & PF.SAFE) && !(me(r).flags & PF.SWIMMING));
        const res = await attack(r, s.weapon);
        expect(res.ok, `${s.name} outside on ${body}: ${JSON.stringify(res)}`).toBe(true);
        await safeLeave(r);
      }
    }, 40_000);
  }
});

describe("creeps in view on arrival at every combat planet (D-zones-2)", () => {
  for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`${body}: a herd and a hostile pack within the 80 m view of the arrival pad`, async () => {
      NPC_TUNING.ambient = true;
      const r = await join(`arrive-${body}`, body, 0);
      const seen = () => {
        const out = { hostile: 0, calm: 0 };
        st(r).npcs?.forEach((n: any) => {
          if (n.hp <= 0) return;
          if (NPC_DEFS[n.kind]!.temper === "hostile") out.hostile++;
          else out.calm++;
        });
        return out;
      };
      await waitFor(() => seen().hostile > 0 && seen().calm > 0, 10_000);
      // The arrival is a safe ring: nobody there can be hurt, the creeps are a short walk out.
      expect(me(r).flags & PF.SAFE).toBeTruthy();
    }, 20_000);
  }
});

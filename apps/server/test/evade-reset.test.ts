// Creeps give up only on targets they can't reach (D-evade-1). A new player standing just outside a
// pad's safe ring was "out of reach" to every creep, because creeps kept 3 m off the ring: a Hopbit
// chasing them gave up after 5 s, ran home healed to full, and from then on every shot woke it into
// giving up again at once (the pad-shooter rule), so 19–24 carbine hits never killed a 22 HP Hopbit
// (e2e, Arcadia). Now a chase may come right up to a ring's edge after a target outside it, so that
// target is fought; a target inside the ring is still out of reach (no pad cheese), and creeps that
// aren't chasing keep the full margin.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, PAD_SAFE_RADIUS, padDirs, type BodyId } from "@firstlight/shared";
import { NF, NPC_INDEX, NPC_RULES } from "@firstlight/shared/content/npcs";
import { siteAnchor, siteDir } from "@firstlight/shared/planet/townFrame";
import type { Game } from "../src/app.ts";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { CHASE_MARGIN } from "../src/world/npc/steer.ts";
import type { V3 } from "../src/world/geometry.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { adminBot, me, sleep, spawnNpc, st } from "./npc-bots.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

/** Site point `metres` from pad `pad` on `bearing` degrees (from north toward east), on the ground. */
function fromPad(w: FakeWorld | null, body: BodyId, pad: number, metres: number, bearing: number): V3 {
  const R = BODIES[body].radius;
  const a = siteAnchor(padDirs(BODIES[body])[pad]!);
  const b = (bearing * Math.PI) / 180;
  const d = siteDir(a, Math.sin(b) * metres, Math.cos(b) * metres, R);
  if (w) return w.world.snapToGround(d);
  return [d[0] * R, d[1] * R, d[2] * R];
}

/** Metres from pad `pad`'s centre along the ground. */
function padDistance(body: BodyId, pad: number, p: readonly number[]): number {
  const d = padDirs(BODIES[body])[pad]!;
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return Math.hypot(p[0]! / l - d[0], p[1]! / l - d[1], p[2]! / l - d[2]) * BODIES[body].radius;
}

describe("creeps and the pad rings, unit (D-evade-1)", () => {
  beforeEach(() => {
    resetTuning();
    NPC_TUNING.ambient = false;
    NPC_TUNING.bosses = false;
  });
  afterEach(() => resetTuning());

  function run(w: FakeWorld, ms: number, each: () => boolean | void): number {
    for (let t = 0; t < ms; t += 50) {
      w.step(50);
      if (each()) return t + 50;
    }
    return -1;
  }

  for (const [body, pad, bearing] of [["arcadia", 0, 120], ["meridian", 0, 150], ["hollowmere", 3, 40]] as const) {
    it(`${body} pad ${pad}: a Hopbit chasing a player 1.8 m outside the ring reaches them and keeps fighting, never giving up`, () => {
      const w = fakeWorld(body, { immortal: true });
      const p = w.addPlayer("hexwick", fromPad(w, body, pad, PAD_SAFE_RADIUS + 1.8, bearing), 1);
      const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, fromPad(w, body, pad, PAD_SAFE_RADIUS + 10, bearing), w.clock.t, { instant: true }) as Npc;
      let evaded = false, closest = Infinity, hurt = false;
      // The player chips at it (1 HP every 0.6 s: it lives ~13 s, well past the 5 s give-up clock).
      run(w, 20_000, () => {
        if (w.clock.t % 600 === 0 && !n.dead) dealDamage(w.world.host, p, n, 1, false);
        if (n.mode === MODE.EVADE) evaded = true;
        if (p.state.hp < p.state.maxHp) hurt = true;
        closest = Math.min(closest, padDistance(body, pad, n.pos));
        return n.dead;
      });
      expect(evaded).toBe(false);
      expect(hurt).toBe(true);
      expect(n.dead).toBe(true);
      // Up to the ring's edge, never into it.
      expect(closest).toBeGreaterThan(PAD_SAFE_RADIUS + CHASE_MARGIN + n.radius - 0.05);
    });
  }

  it("a combat-tagged player shooting from inside the ring is still out of reach: the creep gives up, and at once when woken again", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("padshooter", fromPad(w, "arcadia", 0, 8, 120), 1);
    const n = w.sys.createNpc(NPC_INDEX.get("bonewalker")!, 3, fromPad(w, "arcadia", 0, 20, 120), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, n, 1, false);
    const first = run(w, 12_000, () => n.mode === MODE.EVADE);
    expect(first).toBeGreaterThan(NPC_TUNING.unreachableMs - 100);
    expect(p.state.hp).toBe(p.state.maxHp);
    run(w, 12_000, () => n.mode !== MODE.EVADE); // home and healed
    expect(n.state.hp).toBe(n.state.maxHp);
    // Woken by the same shooter, still inside: it gives up at once (no fresh 5 s window, F12 SF9).
    dealDamage(w.world.host, p, n, 1, false);
    expect(run(w, 500, () => n.mode === MODE.EVADE)).toBeGreaterThan(0);
  });

  it("creeps that aren't chasing keep the full 3 m off the ring; one a chase left inside it walks out", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    // Left 0.9 m from the ring by a chase that just ended: it goes home through the band.
    const n = w.sys.createNpc(NPC_INDEX.get("woolback")!, 1, fromPad(w, "arcadia", 0, 25, 120), w.clock.t, { instant: true }) as Npc;
    n.pos = fromPad(w, "arcadia", 0, PAD_SAFE_RADIUS + 0.9, 120);
    w.sys.setMode(n, MODE.RETURN, w.clock.t);
    const home = run(w, 15_000, () => n.mode !== MODE.RETURN);
    expect(home).toBeGreaterThan(0);
    // Wandering (it roams round its home 25 m out) it never steps back into the band.
    let closest = Infinity;
    run(w, 30_000, () => {
      closest = Math.min(closest, padDistance("arcadia", 0, n.pos));
    });
    expect(closest).toBeGreaterThan(PAD_SAFE_RADIUS + NPC_RULES.safeMargin + n.radius - 0.05);
  });
});

describe("creeps and the pad rings, real server path (D-evade-1)", () => {
  let game: Game;
  const rooms: Room[] = [];
  beforeEach(async () => {
    game = await startServer();
  });
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game.close();
  });

  it("a new player just outside Dawnpad's ring kills a Hopbit that has been trying to reach them, in a few shots", async () => {
    const at = fromPad(null, "arcadia", 0, PAD_SAFE_RADIUS + 1.8, 120);
    const r = await adminBot(game, rooms, "hexquill", "arcadia", at, 1);
    const id = await spawnNpc(r, "hopbit", fromPad(null, "arcadia", 0, PAD_SAFE_RADIUS + 9, 120), { level: 1, instant: true });
    const npc = () => st(r).npcs?.get(id);
    // It notices and keeps trying to reach the player for longer than the 5 s give-up clock.
    await waitFor(() => !!npc() && (npc().flags & NF.AGGRO) !== 0, 6000);
    let evaded = false;
    const watch = setInterval(() => {
      if (npc() && npc().flags & NF.EVADING) evaded = true;
    }, 50);
    try {
      await sleep(6500);
      expect(evaded).toBe(false);
      // Now shoot it: carbine hits (15) on a 22 HP Hopbit.
      let shots = 0;
      while (npc() && npc().hp > 0 && shots < 6) {
        const s = me(r), n = npc();
        const l = Math.hypot(s.x, s.y, s.z), ln = Math.hypot(n.x, n.y, n.z);
        const o: V3 = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
        const c: V3 = [n.x + (n.x / ln) * 0.45, n.y + (n.y / ln) * 0.45, n.z + (n.z / ln) * 0.45];
        const d: V3 = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
        const dl = Math.hypot(...d);
        r.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0] / dl, dy: d[1] / dl, dz: d[2] / dl, t: Date.now() });
        shots++;
        await sleep(700);
      }
      await waitFor(() => !npc() || npc().hp <= 0, 3000);
      expect(shots).toBeLessThanOrEqual(4);
      expect(evaded).toBe(false);
    } finally {
      clearInterval(watch);
    }
  }, 30_000);
});

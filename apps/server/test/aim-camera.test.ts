// The crosshair on a creature means the shot goes at that creature (e2e J3.4: 40 Hexquill bolts with
// the crosshair on a Hopbit 29 m away hit nothing). The client sends the over-the-shoulder camera ray;
// the server picks where it points and fires from the head toward that point. Here the camera is built
// exactly as PlayerController.placeCamera does (default and zoomed all the way out), the crosshair is
// put on a Hopbit-sized creature on flat ground, and every straight-flying delivery must hit it.
// Socket-free: the real combat code on a fake world (no NPC AI ticks, so the target stands still).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { PF } from "@firstlight/shared/net/schema";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import type { NpcActor, PlayerActor } from "../src/world/actors.ts";
import { fire, projectiles, stepProjectiles } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

const R = BODIES.arcadia.radius;
type Ground = "flat" | "drop behind" | "on a rise";
/** How far a unit direction is along the test line from the shooter (metres; see `ground`). */
let along: (d: Vec) => number = () => 0;
/**
 * The ground under the test: flat at the radius, or dropping 25 m just past the target (a crest:
 * nothing behind it for the camera ray to land on), or the target on a 3 m rise.
 */
function terrainFor(kind: Ground, targetAt: number) {
  const groundHeight = (x: number, y: number, z: number) => {
    const a = along([x, y, z]);
    if (kind === "drop behind") return a > targetAt + 1 ? -25 : 0;
    if (kind === "on a rise") return a > targetAt - 2 ? 3 : 0;
    return 0;
  };
  return { body: { radius: R }, groundHeight } as unknown as FakeWorld["world"]["host"]["terrain"];
}

type Vec = [number, number, number];
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

const PAD = padDirs(BODIES.arcadia)[0]! as unknown as Vec;
const REF: Vec = Math.abs(PAD[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
const TAN = norm(sub(REF, [PAD[0] * dot(REF, PAD), PAD[1] * dot(REF, PAD), PAD[2] * dot(REF, PAD)]));
along = (d) => Math.atan2(dot(norm(d), TAN), dot(norm(d), PAD)) * R - 80;

/** `m` metres from the shooter's spot along the test line, `h` metres above the radius. */
function ground(m: number, h = 0): Vec {
  return norm(add(PAD, TAN, (80 + m) / R)).map((v) => v * (R + h)) as Vec;
}

/**
 * The client's camera (PlayerController.placeCamera, on foot) turned until its ray passes through
 * `target`: the camera sits `dist` back, 0.55 m right and 0.25 m up of a point 1.65 m over the feet,
 * looking at 6 m ahead of that point (plus the same right offset). Returns the ray the client sends.
 */
function crosshairOn(feet: Vec, target: Vec, dist: number): { o: Vec; d: Vec } {
  const up = norm(feet);
  const head = add(feet, up, 1.65);
  let look = norm(sub(target, head));
  let o: Vec = head, v: Vec = look;
  for (let i = 0; i < 60; i++) {
    const fwd = norm(sub(look, [up[0] * dot(look, up), up[1] * dot(look, up), up[2] * dot(look, up)]));
    const right = norm(cross(fwd, up));
    o = add(add(add(head, look, -dist), right, 0.55), up, 0.25);
    v = norm(sub(add(add(head, look, 6), right, 0.55), o));
    const want = norm(sub(target, o));
    look = norm(add(look, sub(want, v)));
  }
  return { o, d: v };
}

interface Case {
  weapon: string;
  metres: number[];
  scoped?: boolean;
}

const CASES: Case[] = [
  { weapon: "hexquill", metres: [10, 29, 45] }, // projectile (the owner's)
  { weapon: "emberglass", metres: [10, 29] }, // projectile with splash (range 35)
  { weapon: "carbine", metres: [10, 29, 45], scoped: true }, // hitscan (scoped: 0.3° spread)
  { weapon: "scatterpipe", metres: [10] }, // pellets
  { weapon: "stormcoil", metres: [10, 20] }, // chain (range 22)
];

function shoot(weapon: string, metres: number, dist: number, scoped: boolean, kind: Ground) {
  const w = fakeWorld("arcadia");
  (w.world.host as { terrain: unknown }).terrain = terrainFor(kind, metres);
  const feet = ground(0);
  const p: PlayerActor = w.addPlayer("me", feet, 12);
  p.char.hotbar[0] = { id: weapon, tier: 1, qty: 1 };
  p.char.selected = 0;
  if (scoped) p.state.flags |= PF.SCOPED;
  // A Hopbit (0.45 m radius, 0.9 m tall) standing still `metres` away; its middle is the crosshair.
  const at = ground(metres, kind === "on a rise" ? 3 : 0);
  const n: NpcActor = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, at, w.clock.t, { instant: true });
  n.state.x = at[0];
  n.state.y = at[1];
  n.state.z = at[2];
  n.history.length = 0;
  const hp = n.state.hp;
  const centre = add(at, norm(at), 0.45);
  const { o, d } = crosshairOn(feet, centre, dist);
  const r = fire(w.world.host, p, { ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2] });
  // How close the shot's line passes the creature's middle (the crosshair's point).
  const sent = w.sent.find((m) => m.type === "projectile" || m.type === "shot")?.msg as Record<string, number> | undefined;
  let miss: number | null = null;
  if (sent && "vx" in sent) miss = lineMiss([sent.x!, sent.y!, sent.z!], [sent.vx!, sent.vy!, sent.vz!], centre);
  else if (sent && "dx" in sent && !sent.chain) miss = lineMiss([sent.ox!, sent.oy!, sent.oz!], [sent.dx!, sent.dy!, sent.dz!], centre);
  for (let i = 0; i < 60 && projectiles(w.world.host).length; i++) {
    w.clock.t += 50;
    stepProjectiles(w.world.host, 0.05);
  }
  return { ok: r.ok, hit: n.state.hp < hp, miss };
}

/** Distance from point `c` to the line from `o` along `v`. */
function lineMiss(o: Vec, v: Vec, c: Vec): number {
  const u = norm(v);
  const w = sub(c, o);
  return Math.hypot(...sub(w, [u[0] * dot(w, u), u[1] * dot(w, u), u[2] * dot(w, u)]));
}

// No spread jitter: the line under test is the aim itself (spread is the weapon's, on purpose).
beforeAll(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("the crosshair on a creature: the shot goes at it", () => {
  for (const kind of ["flat", "drop behind", "on a rise"] as const) {
    for (const c of CASES) {
      for (const dist of [4.6, 9]) {
        it(`${kind}: ${c.weapon}, camera ${dist} m back: a Hopbit at ${c.metres.join(" / ")} m is hit`, () => {
          expect(WEAPON_BY_ID.get(c.weapon)).toBeTruthy();
          const got = c.metres.map((m) => shoot(c.weapon, m, dist, !!c.scoped, kind));
          expect(got.map((g) => ({ ok: g.ok, hit: g.hit }))).toEqual(c.metres.map(() => ({ ok: true, hit: true })));
          // Through the middle, not grazing the side the camera happens to be on (chain: no line).
          for (const g of got) if (g.miss !== null) expect(g.miss).toBeLessThan(0.15);
        });
      }
    }
  }
});

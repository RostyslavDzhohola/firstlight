import { describe, expect, it } from "vitest";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "../content/portusTown.ts";
import { dummyDir, TRAINING_DUMMIES } from "../content/onboarding.ts";
import { objectDir, WORLD_OBJECT_BY_ID } from "../content/world.ts";
import { BODIES } from "./bodies.ts";
import { bodyBreakables } from "./breakables.ts";
import { emptyContact, PLAYER_BODY, type XYZ } from "./collide.ts";
import { portalSpots } from "./portals.ts";
import { createTerrain } from "./terrain.ts";
import { hallBoardPlacement, HALL_STAND_SOLIDS, JUNO_COUNTER_ITEM, placeTownItem, structureCollider, townCoords, townDir, townPlacements, townSolids, TOWN_EAST, TOWN_NORTH, type StructureSolid } from "./town.ts";

const terrain = createTerrain("portus");
const R = BODIES.portus.radius;
const town = structureCollider(terrain)!;
const index = (name: string) => TOWN_PREFABS.findIndex((p) => p.name === name);

/** Feet on the ground at town point (east, north), lifted by `lift` metres. */
function feetAt(east: number, north: number, lift = 0): XYZ {
  const d = townDir(east, north, R);
  const r = R + terrain.groundHeight(d[0], d[1], d[2]) + lift;
  return { x: d[0] * r, y: d[1] * r, z: d[2] * r };
}

/**
 * Walk feet in 0.25 m steps from a to b (town points) like the client: the feet keep their height,
 * step up onto tops within PLAYER_BODY.step and drop back to the ground off them. Returns the first
 * step that crosses a structure (or ends inside one), or null.
 */
function walk(a: readonly [number, number], b: readonly [number, number]): [number, number] | null {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
  let prev = feetAt(a[0], a[1]);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const e = a[0] + (b[0] - a[0]) * t, nn = a[1] + (b[1] - a[1]) * t;
    const d = townDir(e, nn, R);
    const ground = R + terrain.groundHeight(d[0], d[1], d[2]);
    const carried = Math.max(ground, Math.hypot(prev.x, prev.y, prev.z));
    const top = town.footing(d[0] * carried, d[1] * carried, d[2] * carried, PLAYER_BODY.step).top;
    const r = top > 0 ? Math.max(ground, top) : ground;
    const p = { x: d[0] * r, y: d[1] * r, z: d[2] * r };
    if (town.crosses(prev.x, prev.y, prev.z, p.x, p.y, p.z) || town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside) return [e, nn];
    prev = p;
  }
  return null;
}

/** Horizontal clearance (m) from a town point to the nearest structure solid below head height (optionally only some). */
function clearance(east: number, north: number, which: (s: StructureSolid) => boolean = () => true): number {
  const p = feetAt(east, north, 0.5);
  let best = Infinity;
  for (const s of townSolids(terrain)) {
    if (!which(s)) continue;
    const qx = p.x - s.px, qy = p.y - s.py, qz = p.z - s.pz;
    const lx = qx * s.rx + qy * s.ry + qz * s.rz, lz = qx * s.fx + qy * s.fy + qz * s.fz;
    const ly = qx * s.ux + qy * s.uy + qz * s.uz;
    if (ly + 1.3 < 0 || ly > s.h) continue; // the body (0.5..1.8 m) misses it vertically
    const d = s.shape === 1 ? Math.max(0, Math.hypot(lx, lz) - s.hx) : Math.hypot(Math.max(0, Math.abs(lx) - s.hx), Math.max(0, Math.abs(lz) - s.hz));
    best = Math.min(best, d);
  }
  return best;
}

describe("Portus town placement (D38)", () => {
  it("uses the game's pole frame and geodesic coordinates", () => {
    expect(townDir(0, 0, R)).toEqual([0, 1, 0]);
    // A small step east/north moves along the frame content/places.ts uses at the pole.
    const d = townDir(1, 0, R), n = townDir(0, 1, R);
    expect(d[0] / Math.hypot(d[0], d[2])).toBeCloseTo(TOWN_EAST[0], 9);
    expect(n[2] / Math.hypot(n[0], n[2])).toBeCloseTo(TOWN_NORTH[2], 9);
    for (const [e, nn] of [[30, -12], [-60, 40], [0.5, 70]] as const) {
      const p = townDir(e, nn, R);
      const c = townCoords(p[0] * 151, p[1] * 151, p[2] * 151, R);
      expect(c[0]).toBeCloseTo(e, 9);
      expect(c[1]).toBeCloseTo(nn, 9);
      expect(Math.acos(p[1]) * R).toBeCloseTo(Math.hypot(e, nn), 9); // arc length
    }
  });

  it("places every item on the ground with an orthonormal, right-handed frame", () => {
    const list = townPlacements(terrain);
    expect(list).toHaveLength(TOWN_LAYOUT.length);
    for (const p of list) {
      const r = [p.rx, p.ry, p.rz], u = [p.ux, p.uy, p.uz], f = [p.fx, p.fy, p.fz];
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(r, r)).toBeCloseTo(1, 9);
      expect(dot(f, f)).toBeCloseTo(1, 9);
      expect(dot(r, u)).toBeCloseTo(0, 9);
      expect(dot(r, f)).toBeCloseTo(0, 9);
      expect(dot(u, f)).toBeCloseTo(0, 9);
      // right × up = front
      expect(r[1]! * u[2]! - r[2]! * u[1]!).toBeCloseTo(f[0]!, 9);
      const len = Math.hypot(p.px, p.py, p.pz);
      expect(len - R).toBeCloseTo(terrain.groundHeight(p.ux, p.uy, p.uz), 9);
    }
    // Yaw 0 faces south (front = -north at the pole); yaw 90 faces east.
    const south = placeTownItem([0, 0, 0, 0, 1], 0, terrain), east = placeTownItem([0, 0, 0, 90, 1], 0, terrain);
    expect([south.fx, south.fy, south.fz].map((v) => v + 0)).toEqual([0, 0, -1].map((v) => v + 0));
    expect(east.fx).toBeCloseTo(TOWN_EAST[0], 12);
  });

  it("is deterministic: two terrains give the same solids", () => {
    const other = createTerrain("portus");
    expect(townSolids(other)).toEqual(townSolids(terrain));
    expect(townSolids(terrain).length).toBeGreaterThan(250);
    // Off Portus the town has nothing; the planet's own sites (its pad outpost) are planet/sites.ts'.
    expect(townSolids(createTerrain("arcadia"))).toEqual([]);
  });

  it("lines the portal courts and the market up with the game's portals, Juno, the Hall wall and the dummies", () => {
    const spots = portalSpots(BODIES.portus, terrain);
    for (const spot of spots) {
      const at = TOWN_FIXED.portals[spot.to as keyof typeof TOWN_FIXED.portals];
      const d = townDir(at[0], at[1], R);
      // within 1 cm on the ground
      expect(Math.hypot(d[0] - spot.dir[0], d[1] - spot.dir[1], d[2] - spot.dir[2]) * R).toBeLessThan(0.01);
      const court = TOWN_LAYOUT.find((it) => TOWN_PREFABS[it[0]]!.name === `portal_court_${spot.to}`)!;
      expect(Math.hypot(court[1] - at[0], court[2] - at[1])).toBeLessThan(0.01);
    }
    for (const [id, at] of [["juno_vale", TOWN_FIXED.juno], ["hall_wall", TOWN_FIXED.plaque]] as const) {
      const d = objectDir(WORLD_OBJECT_BY_ID.get(id)!);
      const t = townDir(at[0], at[1], R);
      expect(Math.hypot(d[0] - t[0], d[1] - t[1], d[2] - t[2]) * R).toBeLessThan(0.01);
    }
    TRAINING_DUMMIES.forEach((_, i) => {
      const d = dummyDir(i);
      const at = TOWN_FIXED.dummies[i]!;
      const t = townDir(at[0], at[1], R);
      expect(Math.hypot(d[0] - t[0], d[1] - t[1], d[2] - t[2]) * R).toBeLessThan(0.01);
    });
  });

  it("keeps Portus at zero breakables", () => {
    expect(bodyBreakables(terrain)).toEqual([]);
  });
});

describe("Portus town structures (D38)", () => {
  it("leaves the spawn ring, the pad and the plaza centre walkable", () => {
    for (let r = 0; r <= 7; r += 1) {
      for (let a = 0; a < 360; a += 15) {
        const e = r * Math.cos((a * Math.PI) / 180), n = r * Math.sin((a * Math.PI) / 180);
        expect(clearance(e, n), `${e.toFixed(1)}, ${n.toFixed(1)}`).toBeGreaterThan(1);
      }
    }
  });

  it("keeps every portal 4 m clear and its approach from the spawn open", () => {
    for (const at of Object.values(TOWN_FIXED.portals)) {
      for (let a = 0; a < 360; a += 10) {
        const e = at[0] + 4 * Math.cos((a * Math.PI) / 180), n = at[1] + 4 * Math.sin((a * Math.PI) / 180);
        expect(clearance(e, n)).toBeGreaterThan(0.38);
      }
      expect(walk([0, 0], at)).toBeNull();
    }
  });

  it("keeps Juno's counter, the Hall wall and the dummies reachable from the spawn", () => {
    expect(walk([0, 0], [0, TOWN_FIXED.juno[1] - 1.6])).toBeNull();
    // Room round Juno besides her own counter (D-solid-1), and the counter's front reachable.
    expect(clearance(0, TOWN_FIXED.juno[1], (x) => x.item !== JUNO_COUNTER_ITEM)).toBeGreaterThan(1);
    const counter = townSolids(terrain).filter((x) => x.item === JUNO_COUNTER_ITEM);
    expect(counter).toHaveLength(1);
    expect(walk([0, 0], [0, TOWN_FIXED.juno[1] - 2.0])).toBeNull();
    expect(walk([0, TOWN_FIXED.juno[1] - 2.2], [0, TOWN_FIXED.juno[1]])).not.toBeNull(); // no walking through the counter
    // The Hall board stands clear of the hall and its steps (its own stand aside), and its front
    // can be walked up to from the spawn.
    const plaque = TOWN_FIXED.plaque;
    expect(clearance(plaque[0], plaque[1], (x) => x.item >= 0)).toBeGreaterThan(0.6);
    expect(walk([0, 0], [plaque[0] * 0.92, plaque[1] * 0.92])).toBeNull();
    for (const d of TOWN_FIXED.dummies) {
      expect(clearance(d[0], d[1])).toBeGreaterThan(1);
      expect(walk([0, 0], [d[0] - 1.2, d[1]])).toBeNull();
    }
  });

  it("makes the Hall of Firsts board's stand solid: no walking through it, nobody left inside it (S4)", () => {
    const stand = townSolids(terrain).filter((x) => x.item === -1);
    expect(stand).toHaveLength(HALL_STAND_SOLIDS.length);
    const board = hallBoardPlacement(terrain)!;
    // The board faces the plaza centre from the authoritative Hall wall position.
    const wall = objectDir(WORLD_OBJECT_BY_ID.get("hall_wall")!);
    expect(Math.hypot(board.ux - wall[0], board.uy - wall[1], board.uz - wall[2])).toBeLessThan(1e-12);
    const [pe, pn] = TOWN_FIXED.plaque;
    const toward = [-pe / Math.hypot(pe, pn), -pn / Math.hypot(pe, pn)] as const; // town plane, at the board
    const at = (d: number) => [pe + toward[0] * d, pn + toward[1] * d] as [number, number];
    // Straight through the board centre from 2 m in front to 2 m behind: the step into the stand is
    // the refused one (the walk reports where that step would have ended).
    const stop = walk(at(2), at(-2));
    expect(stop).not.toBeNull();
    expect(Math.hypot(stop![0] - pe, stop![1] - pn)).toBeLessThan(0.3);
    // ...and the same from behind (the hall side).
    expect(walk(at(-2), at(2))).not.toBeNull();
    // Feet put on the stand (a teleport, an old save) are inside it; the shared push-out and the
    // server's placement both move them clear.
    const p = feetAt(pe, pn);
    expect(town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside).toBe(true);
    const q = { ...p };
    expect(town.resolve(q, emptyContact())).toBe(true);
    expect(town.footing(q.x, q.y, q.z, PLAYER_BODY.step).inside).toBe(false);
    const c = { ...p };
    expect(town.clearSpot(c, (x, y, z) => R + terrain.groundHeight(x, y, z) + 0.02)).toBe(true);
    expect(town.footing(c.x, c.y, c.z, PLAYER_BODY.step).inside).toBe(false);
    // Readable up close: 1 m in front of the board is open ground.
    expect(clearance(...at(1.2))).toBeGreaterThan(0.6);
    // Rays (shots, tracers) stop at the board too.
    const eye = feetAt(...at(4), 1.6);
    const back = feetAt(...at(-1), 1.6);
    const L = Math.hypot(back.x - eye.x, back.y - eye.y, back.z - eye.z);
    expect(town.raycast(eye.x, eye.y, eye.z, (back.x - eye.x) / L, (back.y - eye.y) / L, (back.z - eye.z) / L, L)).toBeLessThan(L);
  });

  it("opens the gate passages and the castle gate: the streets are walkable end to end", () => {
    // East and west streets run through the gatehouses out onto the planet; castle street runs
    // through the castle gate into the ward.
    for (const st of TOWN_STREETS) {
      for (let k = 0; k + 1 < st.pts.length; k++) expect(walk(st.pts[k]!, st.pts[k + 1]!), `${st.name} ${k}`).toBeNull();
    }
    // Into the castle ward up to the keep's front steps (their far riser is 0.44 m above the curved
    // ground: a hop, like the drawn step), and round the keep's side.
    expect(walk([0, 41], [0, 43.8])).toBeNull();
    expect(walk([0, 43.8], [-8, 43.2])).toBeNull();
    expect(walk([-8, 43.2], [-8.5, 52])).toBeNull();
  });

  it("stops a player walking into a house, a wall, a tower or the keep", () => {
    for (const name of ["house_a", "house_b", "house_c", "house_d", "cottage", "market_hall", "hall_of_firsts", "keep", "tower_round", "wall_seg"]) {
      const it = TOWN_LAYOUT.find((x) => x[0] === index(name))!;
      const outside: [number, number] = [it[1] * 0.75, it[2] * 0.75];
      expect(walk(outside, [it[1], it[2]]), name).not.toBeNull();
      // Feet put at its centre are inside, and the shared push-out moves them out sideways.
      const p = feetAt(it[1], it[2]);
      expect(town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside, name).toBe(true);
      const q = { ...p };
      const c = emptyContact();
      expect(town.resolve(q, c), name).toBe(true);
      expect(c.pushed).toBe(true);
      expect(town.footing(q.x, q.y, q.z, PLAYER_BODY.step).inside, name).toBe(false);
    }
  });

  it("clears a body put down inside a building: out past the client's push, nothing left to push (clearSpot)", () => {
    const groundR = (x: number, y: number, z: number) => R + terrain.groundHeight(x, y, z) + 0.02;
    for (const name of ["keep", "market_hall", "hall_of_firsts", "house_b", "tower_round"]) {
      const it = TOWN_LAYOUT.find((x) => x[0] === index(name))!;
      const p = feetAt(it[1], it[2], 0.02);
      expect(town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside, name).toBe(true);
      expect(town.clearSpot(p, groundR), name).toBe(true);
      expect(town.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside, name).toBe(false);
      // The client's own resolve finds nothing to push there, and clearing again doesn't move it.
      const q = { ...p };
      expect(town.resolve(q, emptyContact()), name).toBe(false);
      expect(town.clearSpot(q, groundR)).toBe(true);
      expect(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)).toBeLessThan(1e-6);
      // Out through the nearest face (or round a neighbouring wall), not across the town.
      const half = Math.max(...TOWN_PREFABS[it[0]]!.solids.map((sd) => Math.max(sd[3], sd[4]) + Math.hypot(sd[1], sd[2])));
      const moved = Math.hypot(p.x - feetAt(it[1], it[2], 0.02).x, p.y - feetAt(it[1], it[2], 0.02).y, p.z - feetAt(it[1], it[2], 0.02).z);
      expect(moved, name).toBeLessThan(half + 1.5);
    }
  });

  it("holds feet on low steps and on top of a wall (supportHeightAt)", () => {
    // The Hall of Firsts' front step is 0.32 m high: walkable up, and its top supports the feet.
    const hall = townPlacements(terrain).find((p) => p.prefab === index("hall_of_firsts"))!;
    const stepAt = { x: hall.px + hall.fx * 5.7 * hall.scale, y: hall.py + hall.fy * 5.7, z: hall.pz + hall.fz * 5.7 };
    const r0 = Math.hypot(stepAt.x, stepAt.y, stepAt.z);
    const k = (r0 + 0.32) / r0;
    expect(town.footing(stepAt.x * k, stepAt.y * k, stepAt.z * k, PLAYER_BODY.step).top).toBeCloseTo(r0 + 0.32, 2);
    const wall = townPlacements(terrain).find((p) => p.prefab === index("wall_seg"))!;
    const wr = Math.hypot(wall.px, wall.py, wall.pz);
    const top = (wr + 8.3) / wr;
    expect(town.footing(wall.px * top, wall.py * top, wall.pz * top, PLAYER_BODY.step).top).toBeCloseTo(wr + 8.3, 2);
  });

  it("stops rays at walls (shots and sight lines can use it)", () => {
    const keep = townPlacements(terrain).find((p) => p.prefab === index("keep"))!;
    const from = feetAt(0, 30, 1.5);
    const to = { x: keep.px + keep.ux * 10, y: keep.py + keep.uy * 10, z: keep.pz + keep.uz * 10 };
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz);
    const t = town.raycast(from.x, from.y, from.z, dx / L, dy / L, dz / L, L);
    expect(t).toBeLessThan(L);
  });
});

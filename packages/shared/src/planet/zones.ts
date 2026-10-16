// Safe zones: the one place that says where damage is off, shared so the server's rules (the SAFE
// flag, logout, horses, NPC steering) and the client's HUD zone label can't disagree.
// - Planets: a 12 m ring around every fast-travel pad (D15), and the walled arrival outpost round
//   the main pad (D-b2-1): inside its wall ring is safe, the gates are the border.
// - Portus: the castle town inside its curtain walls, plus the castle ward behind the north wall.
//   Outside the walls is wild land with weak creeps (D-zones-1, amending "all of Portus is safe");
//   the gates are the border. Portus's arrival point and its three portals are all inside the walls.

import { OUTPOSTS, type OutpostBody } from "../content/padOutposts.ts";
import { TOWN_LAYOUT, TOWN_PREFABS } from "../content/portusTown.ts";
import { BODIES, type BodyDef } from "./bodies.ts";
import { chordMetres, padDirs, PAD_SAFE_RADIUS, type Dir } from "./pads.ts";
import { siteAnchor, siteDir, townCoords, townDir } from "./townFrame.ts";

export type ZoneKind = "town" | "outpost" | "pad" | "wild";

export interface Zone {
  safe: boolean;
  kind: ZoneKind;
  /** The pad whose ring holds the position (Portus town: 0, its arrival point), or -1. */
  pad: number;
}

/** A planet's walled arrival outpost (padOutposts.ts `wall`), or null. */
function outpostWall(body: BodyDef): { radius: number; gates: readonly number[] } | null {
  if (body.terrain.kind === "hub") return null;
  return OUTPOSTS[body.id as OutpostBody]?.wall ?? null;
}

/** Inside a planet's outpost walls (the wall ring round its main pad, widened by `margin`)? */
function inOutpost(body: BodyDef, x: number, y: number, z: number, margin: number): boolean {
  const wall = outpostWall(body);
  if (!wall) return false;
  const p = padDirs(body)[0]!;
  const l = Math.sqrt(x * x + y * y + z * z);
  const dx = p[0] - x / l, dy = p[1] - y / l, dz = p[2] - z / l;
  const lim = (wall.radius + margin) / body.radius;
  return dx * dx + dy * dy + dz * dz <= lim * lim;
}

/**
 * Where a zone protects at once (the walled town or outpost: whoever is inside its walls) rather than
 * only out of combat (a pad's ring, F12: no running onto a pad mid-fight). D-zones-3, D-b2-1.
 */
export function protectsAtOnce(kind: ZoneKind): boolean {
  return kind === "town" || kind === "outpost";
}

/**
 * Portus town's safe footprint in the town frame (D38: east/north geodesic metres from the pole).
 * The curtain wall's centre line runs 42.8–44.7 m from the pole and the two gatehouses stand at 46 m,
 * so the border crosses the middle of each gate passage. The castle ward is the walled yard behind
 * the north wall: side walls on east ±15 and the back wall on north 62.7 (1.4 m half thickness).
 */
export const TOWN_SAFE = {
  radius: 46,
  ward: { east: 16.4, north: 64.1 },
} as const;

/** Inside the town's safe footprint, at town coordinates (east, north)? Margin widens it (NPC steering). */
export function inTownSafe(east: number, north: number, margin = 0): boolean {
  if (east * east + north * north <= (TOWN_SAFE.radius + margin) ** 2) return true;
  return Math.abs(east) <= TOWN_SAFE.ward.east + margin && north >= 0 && north <= TOWN_SAFE.ward.north + margin;
}

const _tc: [number, number] = [0, 0];

/** Inside the town's footprint (widened by `margin`)? The town sits around the +Y pole; the far
 * hemisphere is excluded first (townCoords maps both poles to the town centre). */
function inTown(body: BodyDef, x: number, y: number, z: number, margin: number): boolean {
  if (!(y > 0)) return false;
  townCoords(x, y, z, body.radius, _tc);
  return inTownSafe(_tc[0], _tc[1], margin);
}

/** The zone at a planet-space position (any length). */
export function zoneAt(body: BodyDef, x: number, y: number, z: number): Zone {
  if (body.terrain.kind === "hub") return inTown(body, x, y, z, 0) ? { safe: true, kind: "town", pad: 0 } : { safe: false, kind: "wild", pad: -1 };
  const pad = padRingAt(body, x, y, z, 0);
  // Inside the outpost walls: safe; `pad` still says whether you stand in the main pad's ring
  // (pad discovery and fast travel keep the ring's rule).
  if (inOutpost(body, x, y, z, 0)) return { safe: true, kind: "outpost", pad };
  return pad >= 0 ? { safe: true, kind: "pad", pad } : { safe: false, kind: "wild", pad: -1 };
}

function padRingAt(body: BodyDef, x: number, y: number, z: number, margin: number): number {
  const l = Math.sqrt(x * x + y * y + z * z);
  const ux = x / l, uy = y / l, uz = z / l;
  // Chord on the unit sphere, squared: no square root per pad (NPC steering calls this a lot).
  const lim = (PAD_SAFE_RADIUS + margin) / body.radius;
  const lim2 = lim * lim;
  const pads = padDirs(body);
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i]!;
    const dx = p[0] - ux, dy = p[1] - uy, dz = p[2] - uz;
    if (dx * dx + dy * dy + dz * dz <= lim2) return i;
  }
  return -1;
}

/** zoneAt(...).safe without the allocation (the server asks for every player every tick). */
export function isSafe(body: BodyDef, x: number, y: number, z: number): boolean {
  return body.terrain.kind === "hub" ? inTown(body, x, y, z, 0) : inOutpost(body, x, y, z, 0) || padRingAt(body, x, y, z, 0) >= 0;
}

/** Index of the pad whose safe ring contains this position, or -1 (Portus: 0 inside the town walls). */
export function safePadAt(body: BodyDef, x: number, y: number, z: number): number {
  return zoneAt(body, x, y, z).pad;
}

/** Is the position inside a zone that protects at once (protectsAtOnce)? No allocation. */
export function inWalledZone(body: BodyDef, x: number, y: number, z: number): boolean {
  return body.terrain.kind === "hub" ? inTown(body, x, y, z, 0) : inOutpost(body, x, y, z, 0);
}

/** Inside a safe zone or within `margin` metres of one (NPCs keep that far out: NPC_RULES.safeMargin). */
export function nearSafeZone(body: BodyDef, x: number, y: number, z: number, margin: number): boolean {
  if (body.terrain.kind === "hub") return inTown(body, x, y, z, margin);
  return inOutpost(body, x, y, z, margin) || padRingAt(body, x, y, z, margin) >= 0;
}

/**
 * The gates of `body`'s walled zone (the way into safety: the border runs through them) as unit
 * directions: Portus' two town gates, or a planet's outpost gates (on its wall ring); none elsewhere.
 */
export function safeGates(body: BodyDef): readonly Dir[] {
  if (body.terrain.kind === "hub") return TOWN_GATES;
  let list = gateCache.get(body.id);
  if (!list) {
    const wall = outpostWall(body);
    const a = siteAnchor(padDirs(body)[0]!);
    list = (wall?.gates ?? []).map((b) => {
      const r = (b * Math.PI) / 180;
      const d = siteDir(a, Math.sin(r) * wall!.radius, Math.cos(r) * wall!.radius, body.radius);
      return [d[0], d[1], d[2]] as const;
    });
    gateCache.set(body.id, list);
  }
  return list;
}
const gateCache = new Map<string, readonly Dir[]>();

/** The town gates (the gatehouses' centres), as unit directions: the way back into Portus's safe zone. */
export const TOWN_GATES: readonly Dir[] = TOWN_LAYOUT.filter((it) => TOWN_PREFABS[it[0]]?.name === "gatehouse").map((it) => {
  const d = townDir(it[1], it[2], BODIES.portus.radius);
  return [d[0], d[1], d[2]] as const;
});

/**
 * Where the nearest safe zone starts, for the compass: the nearest pad (its ring is `edge` metres
 * around it) or, on Portus, the nearest town gate (edge 0: the border runs through it).
 */
export function nearestSafeEntry(body: BodyDef, x: number, y: number, z: number): { dir: Dir; edge: number } {
  const hub = body.terrain.kind === "hub";
  // Gates (the border runs through them: edge 0), and on a planet the pads outside the outpost
  // (their rings: edge 12 m). The main pad sits inside the outpost: its gates stand for it.
  const gates = safeGates(body);
  const pads = hub ? [] : padDirs(body).slice(outpostWall(body) ? 1 : 0);
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  let best: Dir = gates[0] ?? pads[0]!;
  let bestEdge = gates.length ? 0 : PAD_SAFE_RADIUS;
  let bestD = Infinity;
  const consider = (d: Dir, edge: number) => {
    const m = chordMetres(d, x / l, y / l, z / l, body.radius) - edge;
    if (m < bestD) {
      bestD = m;
      best = d;
      bestEdge = edge;
    }
  };
  for (const g of gates) consider(g, 0);
  for (const p of pads) consider(p, PAD_SAFE_RADIUS);
  return { dir: best, edge: bestEdge };
}

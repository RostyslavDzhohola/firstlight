// Where the tracked hunt mission points (D-zones-2): the nearest live creep in view whose kill would
// count, else the mission's area. Which creeps count is the server's answer (huntTargets: the same
// rule as the kill credit, with each NPC's spawn area); without it (an older server) the shared rule
// runs here on the NPC's current spot. Pure, so it is tested without a scene; MissionPointer.ts
// draws it as a world callout.

import { BODIES, type BodyId, type Terrain } from "@firstlight/shared";
import { wildSitePlacements } from "@firstlight/shared/planet/wildSites";
import { resolveAreaDir } from "@firstlight/shared/content/arenas";
import { huntCredit, type MissionDef } from "@firstlight/shared/content/missions";
import { NPC_AREAS, NPC_DEFS } from "@firstlight/shared/content/npcs";

type V3 = [number, number, number];

export interface PointerNpc {
  id: string;
  kind: number;
  hp: number;
  x: number;
  y: number;
  z: number;
}

export interface PointerTarget {
  at: V3;
  /** What it is: the creep's name, or the area's. */
  title: string;
  /** True when it points at a creep (the callout's metres are to that creep). */
  creep: boolean;
}

const areaDirs = new Map<string, V3>();

function areaOf(id: string | undefined): { name: string; radius: number; dir: V3 } | null {
  const a = id ? NPC_AREAS.find((x) => x.id === id) : undefined;
  if (!a) return null;
  let dir = areaDirs.get(a.id);
  if (!dir) {
    const d = resolveAreaDir(BODIES[a.planet], a.at);
    dir = [d[0]!, d[1]!, d[2]!];
    areaDirs.set(a.id, dir);
  }
  return { name: a.name, radius: a.radius, dir };
}

export interface PointerOptions {
  /** The server's huntTargets for this mission: the NPC ids whose kill would count. */
  eligible?: ReadonlySet<string> | null;
  /** Kills per hunt target so far (you.missions counts), for the fallback rule. */
  counts?: readonly number[];
  /** Where a wild site stands on this body (siteSpot), for a hunt that leads to one (`hunt.site`). */
  siteAt?: (id: string) => { at: V3; name: string } | null;
}

/** A body's wild sites by id: the ground point at each site's origin and its name (for `siteAt`). */
export function siteSpot(terrain: Terrain): (id: string) => { at: V3; name: string } | null {
  return (id) => {
    const w = wildSitePlacements(terrain).find((x) => x.site.id === id);
    if (!w) return null;
    const r = terrain.body.radius + w.base;
    return { at: [w.dir[0] * r, w.dir[1] * r, w.dir[2] * r], name: w.site.name };
  };
}

/** The point the tracked hunt `def` leads to from `me` on `body`, or null (not a hunt, not here). */
export function missionTarget(def: MissionDef, body: BodyId, me: V3, npcs: Iterable<PointerNpc>, groundHeight: (x: number, y: number, z: number) => number, opts: PointerOptions = {}): PointerTarget | null {
  if (def.body !== body || !def.hunt) return null;
  const R = BODIES[body].radius;
  const area = areaOf(def.hunt.place);
  let best: PointerNpc | null = null;
  let bestD = Infinity;
  for (const n of npcs) {
    const d = NPC_DEFS[n.kind];
    if (!d || n.hp <= 0) continue;
    if (opts.eligible) {
      if (!opts.eligible.has(n.id)) continue;
    } else {
      // No word from the server: guess the spawn area from where the NPC stands now.
      let at: string | null = null;
      if (area) {
        const l = Math.hypot(n.x, n.y, n.z);
        if (Math.hypot(n.x / l - area.dir[0], n.y / l - area.dir[1], n.z / l - area.dir[2]) * R <= area.radius) at = def.hunt.place!;
      }
      if (huntCredit(def, opts.counts, d.id, at) < 0) continue;
    }
    const dist = Math.hypot(n.x - me[0], n.y - me[1], n.z - me[2]);
    if (dist < bestD) {
      bestD = dist;
      best = n;
    }
  }
  if (best) return { at: [best.x, best.y, best.z], title: NPC_DEFS[best.kind]!.name, creep: true };
  if (!area) {
    const site = def.hunt.site ? opts.siteAt?.(def.hunt.site) : null;
    return site ? { at: site.at, title: site.name, creep: false } : null;
  }
  const [x, y, z] = area.dir;
  const r = R + Math.max(0, groundHeight(x, y, z));
  return { at: [x * r, y * r, z * r], title: area.name, creep: false };
}

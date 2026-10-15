// Where the tracked hunt mission points (D-zones-2): the nearest live creep in view that counts for
// it (by kind, and inside the mission's area when it has one), else the area itself. Pure, so it is
// tested without a scene; MissionPointer.ts draws it as a world callout.

import { BODIES, type BodyId } from "@firstlight/shared";
import { resolveAreaDir } from "@firstlight/shared/content/arenas";
import type { MissionDef } from "@firstlight/shared/content/missions";
import { NPC_AREAS, NPC_DEFS } from "@firstlight/shared/content/npcs";

type V3 = [number, number, number];

export interface PointerNpc {
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

/** The point the tracked hunt `def` leads to from `me` on `body`, or null (not a hunt, not here). */
export function missionTarget(def: MissionDef, body: BodyId, me: V3, npcs: Iterable<PointerNpc>, groundHeight: (x: number, y: number, z: number) => number): PointerTarget | null {
  if (def.body !== body || !def.hunt) return null;
  const R = BODIES[body].radius;
  const kinds = new Set(def.hunt.targets.map((t) => t.npcKind));
  const area = areaOf(def.hunt.place);
  let best: PointerNpc | null = null;
  let bestD = Infinity;
  for (const n of npcs) {
    const d = NPC_DEFS[n.kind];
    if (!d || n.hp <= 0 || !kinds.has(d.id)) continue;
    if (area) {
      const l = Math.hypot(n.x, n.y, n.z);
      const c = Math.hypot(n.x / l - area.dir[0], n.y / l - area.dir[1], n.z / l - area.dir[2]) * R;
      if (c > area.radius) continue; // kills there wouldn't count
    }
    const dist = Math.hypot(n.x - me[0], n.y - me[1], n.z - me[2]);
    if (dist < bestD) {
      bestD = dist;
      best = n;
    }
  }
  if (best) return { at: [best.x, best.y, best.z], title: NPC_DEFS[best.kind]!.name, creep: true };
  if (!area) return null;
  const [x, y, z] = area.dir;
  const r = R + Math.max(0, groundHeight(x, y, z));
  return { at: [x * r, y * r, z * r], title: area.name, creep: false };
}

// What the map (M) and the minimap mark on a body (pure): named places, peaks and lakes, pads,
// portals, boss lairs, the mission guide, the Portus town's landmarks, and active mission targets.
// Positions come from the same shared content the server uses, so markers sit where things are.

import { SHOP_SPOTS } from "@firstlight/shared/content/shops";
import { BODIES, padDirs, portalSpots, type BodyId, type Terrain } from "@firstlight/shared";
import { GUIDES, MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { anchorDir } from "@firstlight/shared/planet/pads";
import { BOSS_LAIRS, padName, place, placeDir, placesOn } from "@firstlight/shared/content/places";
import { objectDir, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import { townDir } from "@firstlight/shared/planet/townFrame";
import type { V3 } from "../social/compassMath.ts";

export type MarkerKind = "place" | "peak" | "lake" | "pad" | "portal" | "lair" | "guide" | "shop" | "town";

export interface MapMarker {
  id: string;
  kind: MarkerKind;
  dir: V3;
  label: string;
  /** Label priority when the map is crowded (layoutMapLabels): pads/portals 3, people/shops 2, places 1. */
  priority: number;
  /** Pad index (kind "pad"). */
  pad?: number;
  /** Portal destination (kind "portal"). */
  to?: BodyId;
  /** Hunt-area radius in metres (places that are NPC areas): the map rings them when zoomed in. */
  area?: number;
}


/** Portus landmarks in the town frame (east, north metres), from the town layout. */
const PORTUS_SPOTS: readonly [string, number, number][] = [
  ["the Keep", 0, 52.6],
  ["Market hall", 10.6, 27.6],
  ["West gate", -46, 0],
  ["East gate", 46, 0],
];

export function staticMarkers(body: BodyId, terrain: Terrain): MapMarker[] {
  const def = BODIES[body];
  const out: MapMarker[] = [];
  const names = new Set<string>();
  for (const p of placesOn(body)) {
    if (p.kind === "hidden" || p.kind === "pad" || p.kind === "lair") continue;
    out.push({ id: `place:${p.id}`, kind: "place", dir: placeDir(p), label: p.name, priority: 1, ...(p.kind === "area" ? { area: p.radius } : {}) });
    names.add(p.name.toLowerCase());
  }
  for (const pk of def.peaks) {
    if (names.has(pk.name.toLowerCase())) continue;
    out.push({ id: `peak:${pk.name}`, kind: "peak", dir: anchorDir(def, pk.at), label: pk.name, priority: 1 });
  }
  for (const lk of def.lakes) {
    if (names.has(lk.name.toLowerCase())) continue;
    out.push({ id: `lake:${lk.name}`, kind: "lake", dir: anchorDir(def, lk.at), label: lk.name, priority: 1 });
  }
  for (const lair of Object.values(BOSS_LAIRS)) {
    if (lair.body !== body) continue;
    out.push({ id: `lair:${lair.place}`, kind: "lair", dir: placeDir(lair.place), label: `${place(lair.place).name} · ${lair.name}`, priority: 2 });
  }
  if (def.padLayout !== "none") {
    // Unnamed pads are "Waypoint N" in shared content; on the map that reads like your waypoint.
    padDirs(def).forEach((d, i) => out.push({ id: `pad:${i}`, kind: "pad", dir: d, label: padName(body, i).replace(/^Waypoint (\d+)$/, "Pad $1"), priority: 3, pad: i }));
    const guide = GUIDES[body as Exclude<BodyId, "portus">];
    const g = guide && WORLD_OBJECT_BY_ID.get(guide.id);
    if (g) out.push({ id: `guide:${guide.id}`, kind: "guide", dir: objectDir(g), label: `${guide.name} · missions`, priority: 2 });
    for (const s of SHOP_SPOTS) {
      const k = s.body === body ? WORLD_OBJECT_BY_ID.get(s.id) : undefined;
      if (k) out.push({ id: `shop:${s.id}`, kind: "shop", dir: objectDir(k), label: s.name, priority: 2 });
    }
  } else {
    const juno = WORLD_OBJECT_BY_ID.get("juno_vale");
    const hall = WORLD_OBJECT_BY_ID.get("hall_wall");
    if (juno) out.push({ id: "shop:juno", kind: "shop", dir: objectDir(juno), label: "Portus Exchange", priority: 2 });
    if (hall) out.push({ id: "shop:hall", kind: "shop", dir: objectDir(hall), label: "Hall of Firsts", priority: 2 });
    const sela = WORLD_OBJECT_BY_ID.get("curator_sela");
    if (sela) out.push({ id: "guide:curator_sela", kind: "guide", dir: objectDir(sela), label: "Sela Marchbank · the Three Gleams", priority: 2 });
    for (const [name, e, n] of PORTUS_SPOTS) out.push({ id: `town:${name}`, kind: "town", dir: townDir(e, n, def.radius), label: name, priority: 1 });
  }
  for (const s of portalSpots(def, terrain)) {
    out.push({ id: `portal:${s.to}`, kind: "portal", dir: s.dir, label: body === "portus" ? `${BODIES[s.to].name} portal` : `Portal to ${BODIES[s.to].name}`, priority: 3, to: s.to });
  }
  return out;
}

/** Where each active mission on this body points (the mission tracker's targets). */
export function missionTargets(body: BodyId, missions: readonly { id: string; done?: boolean; counts?: readonly number[] }[]): { id: string; dir: V3; label: string }[] {
  const out: { id: string; dir: V3; label: string }[] = [];
  for (const m of missions) {
    if (m.done) continue;
    const md = MISSION_BY_ID.get(m.id as never);
    if (!md || md.body !== body) continue;
    // Race: the first ring (where the clock starts); defend: the beacon; collect: the middle of the
    // pieces still out there (the mission pointer leads to the nearest one).
    const trialAt = md.race ? md.race.rings[0] : md.defend ? md.defend.beacon : null;
    if (trialAt || md.collect) {
      const ids = trialAt ? [trialAt] : md.collect!.pieces.filter((_, i) => !m.counts?.[i]);
      const dirs = ids.map((id) => WORLD_OBJECT_BY_ID.get(id)).filter((o) => !!o).map((o) => objectDir(o!));
      if (!dirs.length) continue;
      const sum = dirs.reduce((s, d) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]] as V3, [0, 0, 0] as V3);
      const l = Math.hypot(sum[0], sum[1], sum[2]) || 1;
      out.push({ id: md.id, dir: [sum[0] / l, sum[1] / l, sum[2] / l], label: md.collect ? `${md.name} (${ids.length} left)` : md.name });
      continue;
    }
    const obj = md.find ? WORLD_OBJECT_BY_ID.get(md.find.object) : undefined;
    const dir = md.reach ? placeDir(md.reach.place) : obj ? objectDir(obj) : md.hunt?.place ? placeDir(md.hunt.place) : null;
    if (dir) out.push({ id: md.id, dir, label: md.name });
  }
  return out;
}

// Named places on every body (docs/content.md §3 area tables, §4 arenas, §5 missions, §6 eggs).
// Positions are computed from pad anchors plus great-circle offsets, so the client (rendering,
// map) and the server (triggers, validation) derive exactly the same spots from the same data.
// Moving a place is a data change here; everything that references it follows.

import { BODIES, type BodyId, type FeatureAnchor } from "../planet/bodies.ts";
import { anchorDir, padDirs, type Dir } from "../planet/pads.ts";

export type PlaceKind = "pad" | "area" | "lair" | "landmark" | "hidden";

/** Where something sits: a pad anchor or another place, then optional offsets. */
export type PlaceRef = FeatureAnchor | { place: string };

export interface PlaceDef {
  id: string;
  body: BodyId;
  name: string;
  kind: PlaceKind;
  at: PlaceRef;
  /** Walk `dist` metres along the surface toward this reference (a pad, anchor or place). */
  toward?: PlaceRef;
  dist?: number;
  /** Extra tangent offsets in metres (north/east of the local frame, see `tangentFrame`). */
  east?: number;
  north?: number;
  /** Radius in metres (hunt areas, map rings). */
  radius: number;
}

export type BossId = "tidewrath" | "hollow_king" | "receiver";

export const PLACES: readonly PlaceDef[] = [
  // ---------------------------------------------------------------- Portus (hub)
  { id: "portus_plaza", body: "portus", name: "Portus Plaza", kind: "landmark", at: { pad: 0 }, radius: 30 },

  // ---------------------------------------------------------------- Arcadia (levels 1–7)
  { id: "dawnpad", body: "arcadia", name: "Dawnpad", kind: "pad", at: { pad: 0 }, radius: 12 },
  { id: "clover_fields", body: "arcadia", name: "Clover Fields", kind: "area", at: { pad: 0 }, toward: { pad: 3 }, dist: 150, north: 40, radius: 110 },
  { id: "lone_oak", body: "arcadia", name: "the lone oak", kind: "landmark", at: { place: "clover_fields" }, east: 40, north: -25, radius: 6 },
  { id: "glasswater_lake", body: "arcadia", name: "Glasswater Lake", kind: "landmark", at: { mid: [3, 7] }, radius: 75 },
  { id: "gull_point", body: "arcadia", name: "Gull Point", kind: "lair", at: { place: "glasswater_lake" }, east: 86, radius: 40 },
  { id: "gull_point_overlook", body: "arcadia", name: "Gull Point overlook", kind: "landmark", at: { place: "glasswater_lake" }, east: 142, radius: 8 },
  { id: "lacefall", body: "arcadia", name: "Lacefall", kind: "area", at: { place: "glasswater_lake" }, north: 92, radius: 40 },
  { id: "lacefall_cave", body: "arcadia", name: "the cave behind Lacefall", kind: "hidden", at: { place: "glasswater_lake" }, north: 106, radius: 5 },
  { id: "pinewhistle_wood", body: "arcadia", name: "Pinewhistle Wood", kind: "area", at: { mid: [1, 7] }, radius: 120 },
  { id: "highscore_hill", body: "arcadia", name: "Highscore Hill", kind: "area", at: { mid: [1, 6] }, radius: 80 },
  { id: "kestrel_peak", body: "arcadia", name: "Kestrel Peak", kind: "landmark", at: { tri: [4, 5, 9] }, radius: 120 },
  { id: "blockyard_camp", body: "arcadia", name: "Blockyard Camp", kind: "area", at: { mid: [3, 5] }, radius: 45 },

  // ---------------------------------------------------------------- Hollowmere (levels 6–13)
  { id: "lanternfall", body: "hollowmere", name: "Lanternfall", kind: "pad", at: { pad: 0 }, radius: 12 },
  { id: "whisper_fen", body: "hollowmere", name: "Whisper Fen", kind: "area", at: { tri: [0, 3, 4] }, radius: 70 },
  { id: "fen_jetty", body: "hollowmere", name: "the Fen jetty", kind: "landmark", at: { place: "whisper_fen" }, toward: { pad: 0 }, dist: 58, radius: 4 },
  { id: "saint_orrins", body: "hollowmere", name: "Saint Orrin's ruin", kind: "area", at: { mid: [0, 2] }, radius: 45 },
  { id: "upside_down_chapel", body: "hollowmere", name: "the Upside-Down Chapel", kind: "hidden", at: { place: "saint_orrins" }, east: -30, north: 52, radius: 6 },
  { id: "thornwood", body: "hollowmere", name: "Thornwood", kind: "area", at: { mid: [1, 2] }, radius: 120 },
  { id: "mourning_mere", body: "hollowmere", name: "Mourning Mere", kind: "landmark", at: { mid: [2, 8] }, radius: 95 },
  { id: "drowned_chapel", body: "hollowmere", name: "the Drowned Chapel", kind: "area", at: { place: "mourning_mere" }, toward: { pad: 2 }, dist: 92, radius: 30 },
  { id: "ferrymans_isle", body: "hollowmere", name: "Ferryman's Isle", kind: "hidden", at: { place: "mourning_mere" }, toward: { pad: 8 }, dist: 104, radius: 8 },
  { id: "tolling_tower", body: "hollowmere", name: "the Tolling Tower", kind: "landmark", at: { pad: 10 }, radius: 8 },
  { id: "hollow_nave", body: "hollowmere", name: "the Hollow Nave", kind: "lair", at: { pad: 10 }, toward: { pad: 4 }, dist: 125, radius: 30 },
  { id: "ossuary_camp", body: "hollowmere", name: "Ossuary Camp", kind: "area", at: { place: "hollow_nave" }, toward: { pad: 4 }, dist: 110, radius: 45 },

  // ---------------------------------------------------------------- Meridian (levels 12–20)
  { id: "waystation_nine", body: "meridian", name: "Waystation Nine", kind: "pad", at: { pad: 0 }, radius: 12 },
  { id: "cinder_canyons", body: "meridian", name: "Cinder Canyons", kind: "area", at: { mid: [0, 2] }, radius: 150 },
  { id: "brinewater_lake", body: "meridian", name: "Brinewater Lake", kind: "landmark", at: { mid: [4, 11] }, radius: 120 },
  { id: "checkpoint_seven", body: "meridian", name: "Checkpoint Seven", kind: "area", at: { mid: [0, 3] }, radius: 60 },
  { id: "vat_room", body: "meridian", name: "the Vat Room", kind: "hidden", at: { place: "checkpoint_seven" }, toward: { pad: 3 }, dist: 120, radius: 6 },
  { id: "foreclosure_yard", body: "meridian", name: "Foreclosure Yard", kind: "lair", at: { mid: [3, 9] }, radius: 40 },
  { id: "yard_gantry", body: "meridian", name: "the Foreclosure Yard gantry", kind: "landmark", at: { place: "foreclosure_yard" }, east: -48, north: -27, radius: 8 },
  { id: "glasspan_flats", body: "meridian", name: "Glasspan Salt Flats", kind: "area", at: { mid: [2, 8] }, radius: 140 },
  { id: "last_billboard", body: "meridian", name: "The Last Billboard", kind: "landmark", at: { place: "glasspan_flats" }, north: 120, radius: 10 },
  { id: "chrome_spires", body: "meridian", name: "Chrome Spires", kind: "landmark", at: { pad: 15 }, radius: 140 },
  { id: "oversight_lobby", body: "meridian", name: "the Oversight Lobby", kind: "area", at: { pad: 15 }, toward: { pad: 9 }, dist: 165, radius: 25 },
];

export const PLACE_BY_ID: ReadonlyMap<string, PlaceDef> = new Map(PLACES.map((p) => [p.id, p]));

export function place(id: string): PlaceDef {
  const p = PLACE_BY_ID.get(id);
  if (!p) throw new Error(`unknown place ${id}`);
  return p;
}

/** Main pad names (pad 0 of each planet). */
export const MAIN_PAD: Record<Exclude<BodyId, "portus">, string> = { arcadia: "dawnpad", hollowmere: "lanternfall", meridian: "waystation_nine" };

/** Boss lairs (the NPC lane should spawn each boss at its lair's position). */
export const BOSS_LAIRS: Record<BossId, { body: BodyId; place: string; name: string }> = {
  tidewrath: { body: "arcadia", place: "gull_point", name: "Tidewrath" },
  hollow_king: { body: "hollowmere", place: "hollow_nave", name: "the Hollow King" },
  receiver: { body: "meridian", place: "foreclosure_yard", name: "The Receiver" },
};

// ---------------------------------------------------------------- geometry (pure functions)

function normalize(x: number, y: number, z: number): Dir {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/** Local frame at `up`: north = the reference axis projected onto the tangent plane; east = north × up. */
export function tangentFrame(up: Dir): { north: Dir; east: Dir } {
  const ref: Dir = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0] * up[0] + ref[1] * up[1] + ref[2] * up[2];
  const north = normalize(ref[0] - k * up[0], ref[1] - k * up[1], ref[2] - k * up[2]);
  const east: Dir = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
  return { north, east };
}

/** Move `east`/`north` metres in the tangent plane at `d` (exact for small offsets). */
export function offsetDir(d: Dir, east: number, north: number, radius: number): Dir {
  if (!east && !north) return d;
  const f = tangentFrame(d);
  const tx = (f.east[0] * east + f.north[0] * north) / radius;
  const ty = (f.east[1] * east + f.north[1] * north) / radius;
  const tz = (f.east[2] * east + f.north[2] * north) / radius;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  // Rotate along the great circle by angle = len (arc length / radius).
  const c = Math.cos(len);
  const s = len > 0 ? Math.sin(len) / len : 0;
  return normalize(d[0] * c + tx * s, d[1] * c + ty * s, d[2] * c + tz * s);
}

/** Walk `metres` along the great circle from `from` toward `to`. */
export function towardDir(from: Dir, to: Dir, metres: number, radius: number): Dir {
  const k = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  let tx = to[0] - k * from[0];
  let ty = to[1] - k * from[1];
  let tz = to[2] - k * from[2];
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-9) return from;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const a = metres / radius;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return normalize(from[0] * c + tx * s, from[1] * c + ty * s, from[2] * c + tz * s);
}

/** Surface distance in metres between two unit directions on a sphere of `radius`. */
export function arcMetres(a: Dir, b: Dir, radius: number): number {
  const k = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(k) * radius;
}

const dirCache = new Map<string, Dir>();

function refDir(body: BodyId, ref: PlaceRef): Dir {
  if ("place" in ref) {
    const p = place(ref.place);
    if (p.body !== body) throw new Error(`place ${ref.place} is on ${p.body}, not ${body}`);
    return placeDir(p);
  }
  if (BODIES[body].padLayout === "none") return [0, 1, 0];
  return anchorDir(BODIES[body], ref);
}

/** Unit direction of a place (cached). */
export function placeDir(p: PlaceDef | string): Dir {
  const def = typeof p === "string" ? place(p) : p;
  const hit = dirCache.get(def.id);
  if (hit) return hit;
  const R = BODIES[def.body].radius;
  let d = refDir(def.body, def.at);
  if (def.toward && def.dist) d = towardDir(d, refDir(def.body, def.toward), def.dist, R);
  if (def.east || def.north) d = offsetDir(d, def.east ?? 0, def.north ?? 0, R);
  dirCache.set(def.id, d);
  return d;
}

export function placesOn(body: BodyId): PlaceDef[] {
  return PLACES.filter((p) => p.body === body);
}

/** Display name of a fast-travel pad: the main pad's name, else "Pad n · near <place>". */
export function padName(body: BodyId, index: number): string {
  if (body === "portus") return "Portus";
  if (index === 0) return place(MAIN_PAD[body]).name;
  const pads = padDirs(BODIES[body]);
  const d = pads[index];
  if (!d) return `Pad ${index}`;
  const R = BODIES[body].radius;
  let best: PlaceDef | null = null;
  let bestD = Infinity;
  for (const p of placesOn(body)) {
    if (p.kind === "hidden" || p.kind === "pad") continue;
    const m = arcMetres(d, placeDir(p), R);
    if (m < bestD) {
      bestD = m;
      best = p;
    }
  }
  return best && bestD < 360 ? `${best.name} pad` : `Waypoint ${index}`;
}

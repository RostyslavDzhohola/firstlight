// Interactive world objects for the quests lane: the Portus Exchange keeper, planet guides, the
// Hall of Firsts wall, mission pickups and every Easter-egg part. Shared so the client (visuals,
// prompts) and the server (validation, triggers) agree on ids and positions.
//
// Position = place direction + tangent offsets, snapped to the ground on each side, + `lift`.

import { BODIES, type BodyId } from "../planet/bodies.ts";
import type { Dir } from "../planet/pads.ts";
import { MAIN_PAD, offsetDir, place, placeDir } from "./places.ts";
import { SHOP_SPOT_BY_ID, SHOP_SPOTS, type ShopSpot } from "./shops.ts";
import type { EggId } from "./secrets.ts";
import type { MissionId } from "./missions.ts";

/** How a player uses it: press E nearby, walk into it, shoot it, or look only. */
export type Trigger = "interact" | "enter" | "shoot" | "none";

export type ObjectLook =
  | "keeper" | "guide" | "hall"
  | "bell" | "ledger" | "memo"
  | "bowl" | "cabinet" | "button" | "plaque" | "burrow" | "lantern" | "ferry" | "chest"
  | "rope" | "well" | "altar" | "safe" | "poster" | "mirror" | "lamp" | "hatch" | "pod";

export interface WorldObjectDef {
  id: string;
  body: BodyId;
  place: string;
  east?: number;
  north?: number;
  /** A fixed spot instead of place + offsets: a world position whose direction is used (shop keepers, shops.ts). */
  at?: readonly [number, number, number];
  /** Metres above the ground (lamps on the billboard). */
  lift?: number;
  /** "place": stand on the ground height at the place centre (parts of one prop share a base). */
  base?: "place";
  look: ObjectLook;
  /** Prompt label ("E — <name>"). Hidden-egg parts use deliberately plain names. */
  name: string;
  trigger: Trigger;
  /** Interaction / trigger radius in metres. */
  range: number;
  mission?: MissionId;
  egg?: EggId;
  /** Egg part key (button icon, rope icon, lantern index…). */
  part?: string;
}

const O = (o: WorldObjectDef) => o;

/** A shop's keeper stands at its spot (content/shops.ts); `place` names the area it belongs to. */
const keeper = (s: ShopSpot, area: string): WorldObjectDef => ({ id: s.id, body: s.body, place: area, at: s.pos, look: "keeper", name: `${s.keeper} · ${s.name}`, trigger: "interact", range: 3 });

function ring(count: number, radius: number, phase = 0): { east: number; north: number }[] {
  const out: { east: number; north: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    out.push({ east: Math.round(Math.sin(a) * radius * 10) / 10, north: Math.round(Math.cos(a) * radius * 10) / 10 });
  }
  return out;
}

export const WORLD_OBJECTS: readonly WorldObjectDef[] = [
  // Portus
  keeper(SHOP_SPOT_BY_ID.get("juno_vale")!, "portus_plaza"),
  O({ id: "hall_wall", body: "portus", place: "portus_plaza", east: -20.8, north: -12, look: "hall", name: "Hall of Firsts", trigger: "none", range: 0 }),

  // Guides on each main pad
  O({ id: "guide_arcadia", body: "arcadia", place: "dawnpad", east: 4.5, north: -3, look: "guide", name: "Lark", trigger: "interact", range: 3 }),
  O({ id: "guide_hollowmere", body: "hollowmere", place: "lanternfall", east: 4.5, north: -3, look: "guide", name: "Sexton Mabry", trigger: "interact", range: 3 }),
  O({ id: "guide_meridian", body: "meridian", place: "waystation_nine", east: 4.5, north: -3, look: "guide", name: "Rook Calder", trigger: "interact", range: 3 }),

  // Mission pickups (visible only while the mission is active)
  O({ id: "a2_bell", body: "arcadia", place: "lacefall", east: 3, north: 4, look: "bell", name: "Pick up the Shepherd's Bell", trigger: "interact", range: 2.5, mission: "A2" }),
  O({ id: "h2_ledger", body: "hollowmere", place: "drowned_chapel", look: "ledger", name: "Take the Sexton's Ledger", trigger: "interact", range: 2.5, mission: "H2" }),
  O({ id: "m2_memo", base: "place", body: "meridian", place: "oversight_lobby", east: 2, look: "memo", name: "Take the memo drive", trigger: "interact", range: 2.5, mission: "M2" }),

  // E1 Behind the Curtain
  O({ id: "e1_bowl", body: "arcadia", place: "lacefall_cave", look: "bowl", name: "Leave a coin in the offering bowl", trigger: "interact", range: 2, egg: "E1" }),

  // E2 Highscore Riddle Chest
  O({ id: "e2_cabinet", base: "place", body: "arcadia", place: "highscore_hill", north: 1.2, look: "cabinet", name: "Read the plaque", trigger: "interact", range: 2.2, egg: "E2", part: "plaque" }),
  O({ id: "e2_btn_rain", base: "place", body: "arcadia", place: "highscore_hill", east: -1.5, north: 0, look: "button", name: "Press the raindrop button", trigger: "interact", range: 0.9, egg: "E2", part: "rain" }),
  O({ id: "e2_btn_leaf", base: "place", body: "arcadia", place: "highscore_hill", east: -0.5, north: 0, look: "button", name: "Press the leaf button", trigger: "interact", range: 0.9, egg: "E2", part: "leaf" }),
  O({ id: "e2_btn_sun", base: "place", body: "arcadia", place: "highscore_hill", east: 0.5, north: 0, look: "button", name: "Press the sun button", trigger: "interact", range: 0.9, egg: "E2", part: "sun" }),
  O({ id: "e2_btn_flame", base: "place", body: "arcadia", place: "highscore_hill", east: 1.5, north: 0, look: "button", name: "Press the flame button", trigger: "interact", range: 0.9, egg: "E2", part: "flame" }),

  // E3 Follow the Gold (the Golden Hopbit itself belongs to the NPC lane)
  O({ id: "e3_burrow", body: "arcadia", place: "lone_oak", east: 1.5, look: "burrow", name: "Crawl into the burrow", trigger: "interact", range: 2, egg: "E3" }),

  // E4 The Ferryman's Lanterns
  ...ring(7, 45, 0.3).map((p, i) =>
    O({ id: `e4_lantern_${i + 1}`, body: "hollowmere", place: "whisper_fen", ...p, look: "lantern", name: "Light the marsh lantern", trigger: "interact", range: 2.2, egg: "E4", part: String(i + 1) }),
  ),
  O({ id: "e4_ferry", body: "hollowmere", place: "fen_jetty", look: "ferry", name: "the ghost ferry", trigger: "enter", range: 3, egg: "E4", part: "ferry" }),
  O({ id: "e4_chest", body: "hollowmere", place: "ferrymans_isle", look: "chest", name: "Open the ferryman's chest", trigger: "interact", range: 2.2, egg: "E4", part: "chest" }),

  // E5 Bellringer
  O({ id: "e5_plaque", base: "place", body: "hollowmere", place: "drowned_chapel", east: 4, north: 3.2, look: "plaque", name: "Read the plaque", trigger: "interact", range: 2, egg: "E5", part: "plaque" }),
  O({ id: "e5_rope_skull", base: "place", body: "hollowmere", place: "drowned_chapel", east: 3, north: 2, look: "rope", name: "Pull the skull rope", trigger: "interact", range: 0.9, egg: "E5", part: "skull" }),
  O({ id: "e5_rope_lantern", base: "place", body: "hollowmere", place: "drowned_chapel", east: 4, north: 2, look: "rope", name: "Pull the broken-lantern rope", trigger: "interact", range: 0.9, egg: "E5", part: "lantern" }),
  O({ id: "e5_rope_candle", base: "place", body: "hollowmere", place: "drowned_chapel", east: 5, north: 2, look: "rope", name: "Pull the candle rope", trigger: "interact", range: 0.9, egg: "E5", part: "candle" }),

  // E6 Down the Well
  O({ id: "e6_well", body: "hollowmere", place: "saint_orrins", look: "well", name: "the old well", trigger: "enter", range: 1.4, egg: "E6", part: "well" }),
  O({ id: "e6_altar", body: "hollowmere", place: "upside_down_chapel", look: "altar", name: "Take the bone bell", trigger: "interact", range: 2.2, egg: "E6", part: "altar" }),

  // E7 Employee of the Month
  O({ id: "e7_safe", base: "place", body: "meridian", place: "oversight_lobby", east: -3, north: 2, look: "safe", name: "Use the wall safe keypad", trigger: "interact", range: 2, egg: "E7", part: "safe" }),
  O({ id: "e7_poster", base: "place", body: "meridian", place: "oversight_lobby", east: 9, north: -2, look: "poster", name: "REFLECT ON YOUR PERFORMANCE", trigger: "none", range: 0, egg: "E7", part: "poster" }),
  O({ id: "e7_mirror", base: "place", body: "meridian", place: "oversight_lobby", east: 9, north: 4, look: "mirror", name: "mirrored digits", trigger: "none", range: 0, egg: "E7", part: "mirror" }),

  // E8 Lights Out
  ...[-6, -3, 0, 3, 6].map((east, i) =>
    O({ id: `e8_lamp_${i + 1}`, base: "place", body: "meridian", place: "last_billboard", east, lift: 62 + (i % 2) * 2, look: "lamp", name: "billboard lamp", trigger: "shoot", range: 0.6, egg: "E8", part: String(i + 1) }),
  ),
  O({ id: "e8_hatch", body: "meridian", place: "last_billboard", north: -24, look: "hatch", name: "Open the maintenance hatch", trigger: "interact", range: 2.2, egg: "E8", part: "hatch" }),

  // E9 Ticket #000 (the trooper is an NPC from the NPC lane; its walk to the lift opens the Vat Room)
  O({ id: "e9_pod", body: "meridian", place: "vat_room", look: "pod", name: "Look inside the open pod", trigger: "interact", range: 2.2, egg: "E9", part: "pod" }),
  O({ id: "e10_plaque", body: "arcadia", place: "pinewhistle_wood", east: 18, north: 20, look: "plaque", name: "Read the weathered dial", trigger: "interact", range: 2, egg: "E10", part: "plaque" }),
  ...["dew", "root", "bloom"].map((part, i) => O({ id: `e10_btn_${part}`, body: "arcadia", place: "pinewhistle_wood", east: 16 + i * 2, north: 17, look: "button", name: `Touch the ${part} carving`, trigger: "interact", range: 1, egg: "E10", part })),
  O({ id: "e11_plaque", body: "hollowmere", place: "thornwood", east: -24, north: 20, look: "plaque", name: "Read the wick keeper's stone", trigger: "interact", range: 2, egg: "E11", part: "plaque" }),
  ...ring(3, 8).map((v, i) => O({ id: `e11_lantern_${i + 1}`, body: "hollowmere", place: "thornwood", east: -24 + v.east, north: 16 + v.north, look: "lantern", name: "Tend the floating wick", trigger: "interact", range: 2, egg: "E11", part: "wick" })),
  O({ id: "e11_chest", body: "hollowmere", place: "thornwood", east: -24, north: 16, look: "chest", name: "Open the reed coffer", trigger: "interact", range: 2, egg: "E11", part: "chest" }),
  O({ id: "e12_plaque", body: "meridian", place: "cinder_canyons", east: 20, north: -18, look: "plaque", name: "Read the discarded work slip", trigger: "interact", range: 2, egg: "E12", part: "plaque" }),
  O({ id: "e12_safe", body: "meridian", place: "cinder_canyons", east: 20, north: -22, look: "safe", name: "Use the timebox keypad", trigger: "interact", range: 2, egg: "E12", part: "safe" }),

  // Shop keepers inside each arrival outpost (round 2), where SHOP_SPOTS puts them.
  ...SHOP_SPOTS.filter((s) => s.body !== "portus").map((s) => keeper(s, MAIN_PAD[s.body as Exclude<BodyId, "portus">])),
];

export const WORLD_OBJECT_BY_ID: ReadonlyMap<string, WorldObjectDef> = new Map(WORLD_OBJECTS.map((o) => [o.id, o]));

export function objectsOn(body: BodyId): WorldObjectDef[] {
  return WORLD_OBJECTS.filter((o) => o.body === body);
}

/** Unit direction of an object (before ground snapping). */
export function objectDir(o: WorldObjectDef): Dir {
  if (o.at) {
    const l = Math.hypot(o.at[0], o.at[1], o.at[2]);
    return [o.at[0] / l, o.at[1] / l, o.at[2] / l];
  }
  const p = place(o.place);
  return offsetDir(placeDir(p), o.east ?? 0, o.north ?? 0, BODIES[o.body].radius);
}

/** World position given a ground-height function (shared terrain on both sides). */
export function objectPos(o: WorldObjectDef, groundHeight: (x: number, y: number, z: number) => number): [number, number, number] {
  const d = objectDir(o);
  const def = BODIES[o.body];
  const h = o.base === "place" ? placeDir(o.place) : d;
  const g = Math.max(groundHeight(h[0], h[1], h[2]), def.waterLevel - 1.05);
  const r = def.radius + g + (o.lift ?? 0) + 0.02;
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** Vertical tolerance (metres) when using an object: props can sit above or below uneven ground. */
export const REACH_VERTICAL = 2.5;

/**
 * Can a player at `p` (feet) use an object at `at`? Horizontal (along the surface) distance within
 * `range + slack`, and vertical distance within REACH_VERTICAL + slack.
 */
export function inReach(at: readonly number[], p: readonly number[], range: number, slack = 0): boolean {
  const la = Math.hypot(at[0]!, at[1]!, at[2]!);
  const lp = Math.hypot(p[0]!, p[1]!, p[2]!);
  const k = (at[0]! * p[0]! + at[1]! * p[1]! + at[2]! * p[2]!) / (la * lp);
  const horizontal = Math.acos(Math.max(-1, Math.min(1, k))) * la;
  return horizontal <= range + slack && Math.abs(lp - la) <= REACH_VERTICAL + slack;
}

/** Horizontal distance (metres along the surface) between two positions, for picking the nearest object. */
export function surfaceDistance(at: readonly number[], p: readonly number[]): number {
  const la = Math.hypot(at[0]!, at[1]!, at[2]!);
  const lp = Math.hypot(p[0]!, p[1]!, p[2]!);
  const k = (at[0]! * p[0]! + at[1]! * p[1]! + at[2]! * p[2]!) / (la * lp);
  return Math.acos(Math.max(-1, Math.min(1, k))) * la;
}

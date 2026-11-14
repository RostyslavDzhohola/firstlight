// Missions (docs/content.md §5): three per planet from the guide NPC at the main pad. All three can
// be active at once; rewards pay the moment the objective completes; each mission can be done once
// per life and resets on rebirth; objective items are mission flags, not inventory items.

import type { BodyId } from "../planet/bodies.ts";
import type { InvItem } from "../net/protocol.ts";

export type MissionType = "hunt" | "find" | "reach" | "race" | "defend" | "collect";
export type MissionId = "A1" | "A2" | "A3" | "H1" | "H2" | "H3" | "M1" | "M2" | "M3" | "A4" | "H4" | "T1" | "T2" | "T3";

export interface HuntTarget {
  /** NPC def id as emitted in kill events by the NPC lane (e.g. "hopbit"). */
  npcKind: string;
  count: number;
  label: string;
}

export interface MissionDef {
  id: MissionId;
  body: Exclude<BodyId, "portus">;
  guide: string;
  type: MissionType;
  name: string;
  objective: string;
  recLevel: [number, number];
  reward: { xp: number; coins: number; items: InvItem[] };
  /** hunt: kills that count (by any credited player), optionally only inside a place. */
  hunt?: { targets: HuntTarget[]; place?: string };
  /** find: interact with this world object (only visible while the mission is active). */
  find?: { object: string; itemName: string };
  /** reach: enter the trigger radius around a place. */
  reach?: { place: string; radius: number };
  /**
   * race: pass through these rings (world-object ids, in order) within `limitS` seconds of passing
   * the first; running out of time fails the attempt, and passing the first ring again restarts it.
   */
  race?: { rings: string[]; radius: number; limitS: number };
  /**
   * defend: light the beacon (a world object, E) and stay within `radius` of it for `holdS` seconds
   * while waves arrive. Outside the ring the clock pauses; outside longer than `graceS`, or dying, fails.
   * Waves are raised at `level` near the defender and pay nothing (like egg penalties).
   */
  defend?: { beacon: string; radius: number; holdS: number; graceS: number; level: number; waves: DefendWave[] };
  /**
   * collect: walk within `radius` of each piece (world-object ids). With `limitS`, the clock starts at
   * the first piece and running out drops the pieces gathered so far.
   */
  collect?: { pieces: string[]; radius: number; limitS?: number; itemName: string };
  /** The world object that gives this mission (default: `guide_<body>`, the planet's guide). */
  giver?: string;
  /** A trial of the Three Gleams (gleams.ts): completing it wins that gleam. */
  trial?: 1 | 2 | 3;
  /** One line the guide says when offering it. */
  pitch: string;
  /** What the mission routes the player toward (content.md §5). */
  routes: string;
}

export interface DefendWave {
  /** Seconds of holding (the beacon's clock) before this wave is raised. */
  atS: number;
  npcKind: string;
  count: number;
}

export interface GuideDef {
  id: string;
  body: Exclude<BodyId, "portus">;
  name: string;
  role: string;
  greeting: string;
}

export const GUIDES: Record<Exclude<BodyId, "portus">, GuideDef> = {
  arcadia: { id: "guide_arcadia", body: "arcadia", name: "Lark", role: "a young shepherd", greeting: "Mind the lake. And the sheep. Mostly the lake." },
  hollowmere: { id: "guide_hollowmere", body: "hollowmere", name: "Sexton Mabry", role: "the chapel grave-keeper", greeting: "Every bell here rings for someone. Try not to make it you." },
  meridian: { id: "guide_meridian", body: "meridian", name: "Rook Calder", role: "an ex-Oversight courier", greeting: "Oversight runs this rock. I just run errands they'd rather I didn't." },
};

const items = (...l: [string, number][]): InvItem[] => l.map(([id, qty]) => ({ id, tier: 1, qty }));

export const MISSIONS: readonly MissionDef[] = [
  {
    id: "A1", body: "arcadia", guide: "Lark", type: "hunt", name: "Pest Control",
    objective: "Kill 8 Hopbits inside Clover Fields", recLevel: [1, 3],
    reward: { xp: 80, coins: 30, items: items(["tonic_small", 2]) },
    hunt: { targets: [{ npcKind: "hopbit", count: 8, label: "Hopbits" }], place: "clover_fields" },
    pitch: "The Hopbits are chewing the clover to stubble. Thin them out for me?",
    routes: "Clover Fields' far edge looks down on Glasswater Lake, where coral spikes break the surface.",
  },
  {
    id: "A2", body: "arcadia", guide: "Lark", type: "find", name: "The Lost Bell",
    objective: "Pick up the Shepherd's Bell at the edge of Lacefall's plunge pool", recLevel: [2, 4],
    reward: { xp: 120, coins: 40, items: [] },
    find: { object: "a2_bell", itemName: "the Shepherd's Bell" },
    pitch: "My flock's bell went down by Lacefall. Funny thing, it keeps ringing.",
    routes: "Light motes drift out of a gap in the falling water.",
  },
  {
    id: "A3", body: "arcadia", guide: "Lark", type: "reach", name: "The Big Lake",
    objective: "Enter the 8 m trigger at the Gull Point overlook", recLevel: [3, 6],
    reward: { xp: 180, coins: 60, items: items(["tonic_large", 1]) },
    reach: { place: "gull_point_overlook", radius: 8 },
    pitch: "Folks say the lake breathes. Don't swim at Gull Point.",
    routes: "Two Tide Stones sit on the shore below the overlook.",
  },
  {
    id: "H1", body: "hollowmere", guide: "Sexton Mabry", type: "hunt", name: "Silence the Choir",
    objective: "Kill 3 Cantors (Ossuary Camp or the causeway ruins)", recLevel: [7, 10],
    reward: { xp: 700, coins: 120, items: [] },
    hunt: { targets: [{ npcKind: "cantor", count: 3, label: "Cantors" }] },
    pitch: "The Cantors sing the dead back up. I'd like the dead to stay put.",
    routes: "Ossuary Camp sits on the causeway to the Hollow Nave.",
  },
  {
    id: "H2", body: "hollowmere", guide: "Sexton Mabry", type: "find", name: "The Sexton's Ledger",
    objective: "Pick up the ledger from the Drowned Chapel altar", recLevel: [8, 11],
    reward: { xp: 900, coins: 150, items: [] },
    find: { object: "h2_ledger", itemName: "the Sexton's Ledger" },
    pitch: "My ledger of the buried is on the Drowned Chapel altar. Something guards it now.",
    routes: "Three bell ropes hang beside the altar.",
  },
  {
    id: "H3", body: "hollowmere", guide: "Sexton Mabry", type: "reach", name: "The Tolling Tower",
    objective: "Reach the top platform of the Tolling Tower", recLevel: [9, 12],
    reward: { xp: 1100, coins: 180, items: [] },
    reach: { place: "tolling_tower", radius: 8 },
    pitch: "Climb the Tolling Tower ramps and tell me what you see in the Nave.",
    routes: "The platform looks into the Hollow Nave's broken roof.",
  },
  {
    id: "M1", body: "meridian", guide: "Rook Calder", type: "hunt", name: "Performance Review",
    objective: "Kill 6 Associates and the Compliance Officer at Checkpoint Seven", recLevel: [13, 16],
    reward: { xp: 2000, coins: 300, items: [] },
    hunt: {
      targets: [
        { npcKind: "associate", count: 6, label: "Associates" },
        { npcKind: "compliance_officer", count: 1, label: "Compliance Officer" },
      ],
      place: "checkpoint_seven",
    },
    pitch: "Checkpoint Seven is due its annual review. Be thorough.",
    routes: "Checkpoint Seven guards the canyon road to Foreclosure Yard.",
  },
  {
    id: "M2", body: "meridian", guide: "Rook Calder", type: "find", name: "Whistleblower",
    objective: "Pick up the memo drive on the manager's desk in the Oversight Lobby", recLevel: [14, 17],
    reward: { xp: 2400, coins: 350, items: [] },
    find: { object: "m2_memo", itemName: "the memo drive" },
    pitch: "There's a memo drive on a desk in the Oversight Lobby. Nobody reads memos. I do.",
    routes: "There's a wall safe in the same office, and a break-room mirror next door.",
  },
  {
    id: "M3", body: "meridian", guide: "Rook Calder", type: "reach", name: "Site Visit",
    objective: "Reach the gantry overlook above Foreclosure Yard", recLevel: [15, 18],
    reward: { xp: 2800, coins: 400, items: items(["copper_orbit_pack", 1]) },
    reach: { place: "yard_gantry", radius: 8 },
    pitch: "Get eyes on Foreclosure Yard from the gantry. Don't get repossessed.",
    routes: "Both Override Consoles are visible from the gantry.",
  },
  // ---------------------------------------------------------------- 2026-11-12: new objective types
  {
    id: "A4", body: "arcadia", guide: "Lark", type: "collect", name: "Kite Season",
    objective: "Gather the 5 torn kite panels the wind dropped in the meadow between Dawnpad and Clover Fields", recLevel: [1, 3],
    reward: { xp: 60, coins: 25, items: [] },
    collect: { pieces: ["a4_kite_1", "a4_kite_2", "a4_kite_3", "a4_kite_4", "a4_kite_5"], radius: 2.5, itemName: "kite panels" },
    pitch: "The wind took my kite apart. The pieces glow a bit, they're lined. Follow the glow.",
    routes: "The meadow runs on into Clover Fields, where the Hopbits graze.",
  },
  {
    id: "H4", body: "hollowmere", guide: "Sexton Mabry", type: "defend", name: "The Long Vigil",
    objective: "Light the vigil lamp on the Saint Orrin's road and keep it company for 60 seconds", recLevel: [9, 12],
    reward: { xp: 900, coins: 150, items: [] },
    defend: {
      beacon: "h4_lamp", radius: 14, holdS: 60, graceS: 10, level: 9,
      waves: [
        { atS: 2, npcKind: "bonewalker", count: 2 },
        { atS: 25, npcKind: "gnawer", count: 2 },
        { atS: 45, npcKind: "bonewalker", count: 2 },
      ],
    },
    pitch: "Someone has to sit with the vigil lamp tonight. The dead dislike company. Bring a weapon.",
    routes: "The road climbs on toward Saint Orrin's ruin and its old well.",
  },
  // ---------------------------------------------------------------- the Three Gleams (gleams.ts), from Sela Marchbank in Portus
  {
    id: "T1", body: "arcadia", guide: "Sela Marchbank", giver: "curator_sela", trial: 1, type: "race", name: "The Swift Gleam",
    objective: "Run the eight lit rings around Highscore Hill, in order, within 75 seconds of the first", recLevel: [4, 7],
    reward: { xp: 300, coins: 80, items: [] },
    race: { rings: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `t1_ring_${i}`), radius: 4.5, limitS: 75 },
    pitch: "The first gleam never sits still. It runs a ring road on Arcadia; keep pace and it's yours.",
    routes: "The ring road circles Highscore Hill; its crowns of voxel creatures don't like runners.",
  },
  {
    id: "T2", body: "hollowmere", guide: "Sela Marchbank", giver: "curator_sela", trial: 2, type: "defend", name: "The Steadfast Gleam",
    objective: "Light the beacon in south Thornwood and hold its ring for 90 seconds", recLevel: [9, 12],
    reward: { xp: 1000, coins: 160, items: [] },
    defend: {
      beacon: "t2_beacon", radius: 14, holdS: 90, graceS: 10, level: 9,
      waves: [
        { atS: 2, npcKind: "bonewalker", count: 2 },
        { atS: 22, npcKind: "gnawer", count: 2 },
        { atS: 45, npcKind: "bonewalker", count: 2 },
        { atS: 65, npcKind: "gnawer", count: 3 },
      ],
    },
    pitch: "The second gleam is a beacon the Hollow Court wants dark. Light it, then don't let it be alone.",
    routes: "South Thornwood, a long walk from the lantern-lit pad; the trees are full of things that used to be people.",
  },
  {
    id: "T3", body: "meridian", guide: "Sela Marchbank", giver: "curator_sela", trial: 3, type: "collect", name: "The Patient Gleam",
    objective: "Gather the 8 shards of the third gleam on the Glasspan Salt Flats within 4 minutes of the first", recLevel: [14, 17],
    reward: { xp: 2400, coins: 350, items: [] },
    collect: { pieces: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `t3_shard_${i}`), radius: 2.5, limitS: 240, itemName: "gleam shards" },
    pitch: "The third gleam broke on Meridian's salt. Gather every shard before Oversight files them away.",
    routes: "The Glasspan Salt Flats: open ground, long sightlines, and patrols that notice you.",
  },
];

export const MISSION_BY_ID: ReadonlyMap<string, MissionDef> = new Map(MISSIONS.map((m) => [m.id, m]));

/** The guide missions of a planet (what its guide hands out). Sela's trials are not in here. */
export function missionsOn(body: BodyId): MissionDef[] {
  return MISSIONS.filter((m) => m.body === body && !m.giver);
}

/** Total goal units for the progress bar (hunt: sum of counts; race: rings; defend: seconds held; collect: pieces; find/reach: 1). */
export function missionGoal(m: MissionDef): number {
  if (m.hunt) return m.hunt.targets.reduce((s, t) => s + t.count, 0);
  if (m.race) return m.race.rings.length;
  if (m.defend) return m.defend.holdS;
  if (m.collect) return m.collect.pieces.length;
  return 1;
}

/** The nine original guide missions: Errand Runner (medal 6) asks for these, not later additions. */
export const ERRAND_MISSIONS: readonly MissionId[] = ["A1", "A2", "A3", "H1", "H2", "H3", "M1", "M2", "M3"];

/** The world object that gives a mission: its `giver`, else the planet guide. */
export function missionGiver(def: MissionDef): string {
  return def.giver ?? `guide_${def.body}`;
}

/** Missions a giver hands out (the guide's or Sela Marchbank's panel). */
export function missionsFrom(giver: string): MissionDef[] {
  return MISSIONS.filter((m) => missionGiver(m) === giver);
}

/** Objective types run as a timed or tracked attempt on the server (quests/trials.ts). */
export function isTrialType(m: MissionDef): boolean {
  return !!(m.race || m.defend || m.collect);
}

/** The defend waves that every NPC kind of the catalogue must exist for (checked in tests). */
export const DEFEND_NPC_KINDS: readonly string[] = [...new Set(MISSIONS.flatMap((m) => m.defend?.waves.map((w) => w.npcKind) ?? []))];

/** Every NPC kind a hunt mission listens for (the NPC lane must emit these ids). */
export const MISSION_NPC_KINDS: readonly string[] = [...new Set(MISSIONS.flatMap((m) => m.hunt?.targets.map((t) => t.npcKind) ?? []))];

/**
 * The hunt target an NPC of `npcKind` that spawned in `area` (its spawn point's area: null for
 * wilds and admin spawns) is for, ignoring quotas, or -1. The mission's place, if any, must match.
 */
export function huntTargetIndex(def: MissionDef, npcKind: string, area: string | null): number {
  if (!def.hunt || (def.hunt.place && area !== def.hunt.place)) return -1;
  return def.hunt.targets.findIndex((t) => t.npcKind === npcKind);
}

/**
 * The hunt target a kill of that NPC would advance (its quota in `counts`, per target, isn't full
 * yet), or -1. One rule for the server's kill credit and the client's mission pointer (D-zones-2).
 */
export function huntCredit(def: MissionDef, counts: readonly number[] | undefined, npcKind: string, area: string | null): number {
  const i = huntTargetIndex(def, npcKind, area);
  if (i < 0) return -1;
  return (counts?.[i] ?? 0) < def.hunt!.targets[i]!.count ? i : -1;
}

/**
 * The mission the HUD tracker marks as tracked and the mission pointer follows: the one the player
 * chose (`chosen`, #69) while it is still open, else the first open one given out on `body`, else
 * the first open one anywhere.
 */
export function trackedMission<T extends { id: string; done: boolean }>(missions: readonly T[], body: BodyId, chosen: string | null = null): T | null {
  const pick = chosen ? missions.find((m) => m.id === chosen && !m.done && MISSION_BY_ID.has(m.id)) : undefined;
  return pick ?? missions.find((m) => !m.done && MISSION_BY_ID.get(m.id)?.body === body) ?? missions.find((m) => !m.done) ?? null;
}

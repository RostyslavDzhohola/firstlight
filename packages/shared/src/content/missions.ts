// Missions (docs/content.md §5): three per planet from the guide NPC at the main pad. All three can
// be active at once; rewards pay the moment the objective completes; each mission can be done once
// per life and resets on rebirth; objective items are mission flags, not inventory items.

import type { BodyId } from "../planet/bodies.ts";
import type { InvItem } from "../net/protocol.ts";

export type MissionType = "hunt" | "find" | "reach";
export type MissionId = "A1" | "A2" | "A3" | "H1" | "H2" | "H3" | "M1" | "M2" | "M3";

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
  /** One line the guide says when offering it. */
  pitch: string;
  /** What the mission routes the player toward (content.md §5). */
  routes: string;
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
    reward: { xp: 2800, coins: 400, items: [] },
    reach: { place: "yard_gantry", radius: 8 },
    pitch: "Get eyes on Foreclosure Yard from the gantry. Don't get repossessed.",
    routes: "Both Override Consoles are visible from the gantry.",
  },
];

export const MISSION_BY_ID: ReadonlyMap<string, MissionDef> = new Map(MISSIONS.map((m) => [m.id, m]));

export function missionsOn(body: BodyId): MissionDef[] {
  return MISSIONS.filter((m) => m.body === body);
}

/** Total goal units for the progress bar (hunt: sum of counts; find/reach: 1). */
export function missionGoal(m: MissionDef): number {
  return m.hunt ? m.hunt.targets.reduce((s, t) => s + t.count, 0) : 1;
}

/** Every NPC kind a hunt mission listens for (the NPC lane must emit these ids). */
export const MISSION_NPC_KINDS: readonly string[] = [...new Set(MISSIONS.flatMap((m) => m.hunt?.targets.map((t) => t.npcKind) ?? []))];

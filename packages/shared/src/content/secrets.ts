// Easter eggs (docs/content.md §6) and the Hall of Firsts plaques. Four eggs per planet; each
// gives a rare item (once per life; it drops on death like any item) and a hidden medal (once per
// account). The first account to claim each egg is engraved on its plaque in Portus.

import type { BodyId } from "../planet/bodies.ts";
import type { InvItem } from "../net/protocol.ts";
import type { BossId } from "./places.ts";

export type EggId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" | "E12";

export interface EggDef {
  id: EggId;
  body: Exclude<BodyId, "portus">;
  name: string;
  /** Place id (places.ts) where the egg lives. */
  place: string;
  item: InvItem & { skin?: string };
  itemName: string;
  medal: string;
  extra?: boolean;
}

export const EGGS: readonly EggDef[] = [
  { id: "E1", body: "arcadia", name: "Behind the Curtain", place: "lacefall_cave", item: { id: "lantern_of_lacefall", tier: 1, qty: 1 }, itemName: "Lantern of Lacefall", medal: "behind_the_curtain" },
  { id: "E2", body: "arcadia", name: "Highscore Riddle Chest", place: "highscore_hill", item: { id: "pixel_halo", tier: 1, qty: 1 }, itemName: "Pixel Halo", medal: "new_high_score" },
  { id: "E3", body: "arcadia", name: "Follow the Gold", place: "lone_oak", item: { id: "golden_hopbit", tier: 1, qty: 1 }, itemName: "Golden Hopbit", medal: "follow_the_gold" },
  { id: "E4", body: "hollowmere", name: "The Ferryman's Lanterns", place: "ferrymans_isle", item: { id: "riverstaff", tier: 2, qty: 1, skin: "ferrymans_oar" }, itemName: "Ferryman's Oar", medal: "paid_the_ferryman" },
  { id: "E5", body: "hollowmere", name: "Bellringer", place: "drowned_chapel", item: { id: "candle_crown", tier: 1, qty: 1 }, itemName: "Candle Crown", medal: "bellringer" },
  { id: "E6", body: "hollowmere", name: "Down the Well", place: "upside_down_chapel", item: { id: "bone_bell", tier: 1, qty: 1 }, itemName: "Bone Bell", medal: "down_the_well" },
  { id: "E7", body: "meridian", name: "Employee of the Month", place: "oversight_lobby", item: { id: "executive_visor", tier: 1, qty: 1 }, itemName: "Executive Visor", medal: "employee_of_the_month" },
  { id: "E8", body: "meridian", name: "Lights Out", place: "last_billboard", item: { id: "static_cloak", tier: 1, qty: 1 }, itemName: "Static Cloak", medal: "lights_out" },
  { id: "E9", body: "meridian", name: "Ticket #000", place: "vat_room", item: { id: "ticket_000_helmet", tier: 1, qty: 1 }, itemName: "Ticket #000 Helmet", medal: "not_a_clone" },
  { id: "E10", body: "arcadia", name: "The Dewdial", place: "pinewhistle_wood", item: { id: "dewdial_crown", tier: 1, qty: 1 }, itemName: "Dewdial Crown", medal: "tended_the_dawn", extra: true },
  { id: "E11", body: "hollowmere", name: "Afloat in the Dark", place: "thornwood", item: { id: "wickfloat_mantle", tier: 1, qty: 1 }, itemName: "Wickfloat Mantle", medal: "kept_the_wicks", extra: true },
  { id: "E12", body: "meridian", name: "The Quiet Shift", place: "cinder_canyons", item: { id: "quietshift_lens", tier: 1, qty: 1 }, itemName: "Quietshift Lens", medal: "off_the_clock", extra: true },
];

export const EGG_BY_ID: ReadonlyMap<string, EggDef> = new Map(EGGS.map((e) => [e.id, e]));

/** Tuning for the egg mechanics (content.md §6). */
export const EGG_RULES = {
  E1_COST: 1,
  E2_ORDER: ["rain", "leaf", "sun", "flame"] as const,
  E2_PENALTY_HOPBITS: 3,
  E3_FOLLOW_SECONDS: 60,
  E3_FOLLOW_METRES: 15,
  E3_BURROW_OPEN_MS: 5 * 60_000,
  E4_LANTERNS: 7,
  E4_WINDOW_MS: 180_000,
  E4_FERRY_MS: 60_000,
  E5_ORDER: ["skull", "lantern", "candle"] as const,
  E5_PENALTY_BONEWALKERS: 2,
  E7_CODE: "7041",
  E8_LAMPS: 5,
  E8_WINDOW_MS: 20_000,
  E8_LAMP_RADIUS: 0.6,
  /** How long an opened passage (burrow, ferry ride, hatch, lift, well) stays valid for that player. */
  PASSAGE_MS: 5 * 60_000,
} as const;

// ---------------------------------------------------------------- Hall of Firsts

export interface PlaqueDef {
  /** Secret id used with claimFirst (egg id, or `boss:<id>` for first boss kills). */
  id: string;
  /** Shown before anyone claims it (eggs stay mysterious). */
  hiddenLabel: string;
  /** Shown once claimed. */
  label: string;
}

export const BOSS_FIRSTS: Record<BossId, string> = { tidewrath: "boss:tidewrath", hollow_king: "boss:hollow_king", receiver: "boss:receiver" };

export const PLAQUES: readonly PlaqueDef[] = [
  ...EGGS.slice(0, 9).map((e, i) => ({ id: e.id, hiddenLabel: `Secret ${i + 1} · ${e.body[0]!.toUpperCase()}${e.body.slice(1)}`, label: e.name })),
  { id: BOSS_FIRSTS.tidewrath, hiddenLabel: "First to fell Tidewrath", label: "Tidewrath falls" },
  { id: BOSS_FIRSTS.hollow_king, hiddenLabel: "First to fell the Hollow King", label: "The Hollow King falls" },
  { id: BOSS_FIRSTS.receiver, hiddenLabel: "First to fell The Receiver", label: "The Receiver falls" },
  ...EGGS.slice(9).map((e, i) => ({ id: e.id, hiddenLabel: `Secret ${i + 10} · ${e.body[0]!.toUpperCase()}${e.body.slice(1)}`, label: e.name })),
];

/** One engraved line, as sent to clients (`hall` message). */
export interface HallLine {
  id: string;
  name: string;
  foundAt: number;
}

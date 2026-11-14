// Wild sites (lane world, 2026-11-13; issue #72): built places out in the planets' wilds, away from the
// pads: a ruin, a watchtower you climb, a shrine, a cave mouth, and one landmark per planet seen from
// afar. Each has a level band, a guardian with its pack, a chest that opens when the guardian falls
// (loot scaled to the band) and a discovery (XP once per life, decided on the server). Numbers are in
// docs/content.md §3.6. Where each one stands is planet/wildSites.ts (deterministic, shared); its
// model and colliders come from the Blender build (content/wildSitePrefabs.ts).
//
// Site ids are persistence keys (LifeProgress.sites): append, never rename or reuse.

import type { BodyId } from "../planet/bodies.ts";
import { xpToNext } from "./progression.ts";
import type { AreaAnchor, CampChest } from "./npcs.ts";

export type WildSiteBody = Exclude<BodyId, "portus">;
export type WildSiteKind = "watchtower" | "ruin" | "landmark" | "shrine" | "cave";

export interface WildSiteDef {
  id: string;
  name: string;
  body: WildSiteBody;
  kind: WildSiteKind;
  /** Prefab name in WILD_SITE_PREFABS. */
  prefab: string;
  /** Where the placement search starts: an area anchor, then east/north metres in its tangent frame. */
  at: AreaAnchor;
  east?: number;
  north?: number;
  /** Yaw (degrees CCW from above; 0 = the front faces south). */
  yaw: number;
  /** Level band: guardian and pack levels sit inside it; the map and nameplates show it. */
  levels: [number, number];
  /** The guardian (its death opens the chest) and its pack; levels inside the band. */
  guardian: { kind: string; level: number };
  pack: { kind: string; count: number; level: number }[];
  chest: CampChest;
  /** One-line journal entry. */
  blurb: string;
}

/** Discovery XP: 30 % of the XP from the band's lower level to the next, rounded to 5. */
export function siteDiscoveryXp(site: Pick<WildSiteDef, "levels">): number {
  return Math.round((0.3 * xpToNext(site.levels[0])) / 5) * 5;
}

/** Feet within this many metres of a site's footprint (its prefab `foot`) discover it. */
export const SITE_DISCOVER_MARGIN = 10;

export const WILD_SITES: readonly WildSiteDef[] = [
  // ---------------------------------------------------------------- Arcadia (1–7)
  {
    id: "bellwether_watch", name: "Bellwether Watch", body: "arcadia", kind: "watchtower", prefab: "a_watchtower",
    at: { between: [0, 1, 0.3] }, yaw: 20, levels: [2, 3],
    guardian: { kind: "linewyrm", level: 3 },
    pack: [{ kind: "hopbit", count: 4, level: 2 }, { kind: "sparkfly", count: 1, level: 3 }],
    chest: { coins: 25, weapons: 0, tonics: 1 },
    blurb: "A limestone watchtower with a bell at the top. Climb it and look for the arch.",
  },
  {
    id: "emberfall_keep", name: "Emberfall Keep", body: "arcadia", kind: "ruin", prefab: "a_ruin",
    at: { between: [0, 3, 0.55] }, yaw: -30, levels: [4, 5],
    guardian: { kind: "pixel_lancer", level: 5 },
    pack: [{ kind: "bomblet", count: 2, level: 4 }, { kind: "hopbit", count: 3, level: 4 }, { kind: "linewyrm", count: 1, level: 5 }],
    chest: { coins: 45, weapons: 1, tonics: 1 },
    blurb: "A roofless keep with a fallen tower. Something still guards its court.",
  },
  {
    id: "skyhook_arch", name: "Skyhook Arch", body: "arcadia", kind: "landmark", prefab: "a_arch",
    at: { between: [0, 1, 0.5] }, east: 50, yaw: 75, levels: [6, 7],
    guardian: { kind: "cabinet_golem", level: 7 },
    pack: [{ kind: "pixel_lancer", count: 2, level: 6 }, { kind: "sparkfly", count: 2, level: 6 }, { kind: "bomblet", count: 1, level: 7 }],
    chest: { coins: 80, weapons: 1, tonics: 2, cosmetic: { id: "voxel_visor", chance: 1 / 12 } },
    blurb: "A rock arch you can see from the watchtower. The Brightbits nest at its foot.",
  },

  // ---------------------------------------------------------------- Hollowmere (6–13)
  {
    id: "lantern_shrine", name: "The Lantern Shrine", body: "hollowmere", kind: "shrine", prefab: "h_shrine",
    at: { between: [0, 1, 0.26] }, yaw: 0, levels: [7, 8],
    guardian: { kind: "cantor", level: 8 },
    pack: [{ kind: "bonewalker", count: 3, level: 7 }, { kind: "marsh_wisp", count: 2, level: 7 }],
    chest: { coins: 70, weapons: 0, tonics: 1 },
    blurb: "A ring of slate stones round an altar. The lantern on the obelisk never goes out.",
  },
  {
    id: "sunken_barrow", name: "The Sunken Barrow", body: "hollowmere", kind: "cave", prefab: "h_cave",
    at: { between: [0, 5, 0.55] }, yaw: 160, levels: [9, 11],
    guardian: { kind: "crypt_sentinel", level: 11 },
    pack: [{ kind: "bonewalker", count: 3, level: 10 }, { kind: "bone_archer", count: 2, level: 9 }],
    chest: { coins: 120, weapons: 1, tonics: 2 },
    blurb: "A cave mouth shored with black oak. The barrow chest is at the back of the chamber.",
  },
  {
    id: "hollow_elm", name: "The Hollow Elm", body: "hollowmere", kind: "landmark", prefab: "h_tree",
    at: { between: [0, 1, 0.45] }, east: 30, yaw: 200, levels: [12, 13],
    guardian: { kind: "crypt_sentinel", level: 13 },
    pack: [{ kind: "cantor", count: 1, level: 12 }, { kind: "bone_archer", count: 2, level: 12 }, { kind: "gnawer", count: 3, level: 12 }],
    chest: { coins: 200, weapons: 1, tonics: 2, cosmetic: { id: "crowbeak_mask", chance: 1 / 12 } },
    blurb: "A dead giant thirty metres tall, hung with cages. Seen from the shrine.",
  },

  // ---------------------------------------------------------------- Meridian (12–20)
  {
    id: "relay_mast_four", name: "Relay Mast Four", body: "meridian", kind: "watchtower", prefab: "m_relay",
    at: { between: [0, 1, 0.25] }, yaw: 0, levels: [13, 14],
    guardian: { kind: "enforcer", level: 14 },
    pack: [{ kind: "associate", count: 3, level: 13 }, { kind: "collector", count: 1, level: 13 }],
    chest: { coins: 150, weapons: 1, tonics: 1 },
    blurb: "An Oversight relay on a concrete block. Climb the stair to see the wreck.",
  },
  {
    id: "foreclosed_depot", name: "The Foreclosed Depot", body: "meridian", kind: "ruin", prefab: "m_depot",
    at: { between: [0, 2, 0.6] }, yaw: 35, levels: [15, 17],
    guardian: { kind: "compliance_officer", level: 17 },
    pack: [{ kind: "enforcer", count: 2, level: 16 }, { kind: "associate", count: 3, level: 15 }, { kind: "auditor", count: 1, level: 16 }],
    chest: { coins: 260, weapons: 1, tonics: 2 },
    blurb: "A freight depot gone to ruin. The Oversight still holds its yard.",
  },
  {
    id: "long_haul_wreck", name: "The Long Haul wreck", body: "meridian", kind: "landmark", prefab: "m_hull",
    at: { between: [0, 1, 0.55] }, east: 80, yaw: 120, levels: [19, 20],
    guardian: { kind: "compliance_officer", level: 20 },
    pack: [{ kind: "enforcer", count: 2, level: 19 }, { kind: "auditor", count: 2, level: 19 }, { kind: "collector", count: 1, level: 20 }],
    chest: { coins: 420, weapons: 2, tonics: 2 },
    blurb: "A freighter broken in two in the salt. Its chest sits in the break.",
  },

  // ---------------------------------------------------------------- Lumen (6–9; #6)
  // Its one landmark reuses the Meridian hauler hull: an Oversight freighter that never made it
  // home, broken across a crater.
  {
    id: "quietfall_wreck", name: "The Quietfall Wreck", body: "lumen", kind: "landmark", prefab: "m_hull",
    at: { between: [0, 1, 0.5] }, yaw: 140, levels: [8, 9],
    guardian: { kind: "cratermaw", level: 9 },
    pack: [{ kind: "glimmerhop", count: 3, level: 8 }, { kind: "dustmoth", count: 2, level: 8 }],
    chest: { coins: 110, weapons: 1, tonics: 1 },
    blurb: "A freighter broken across a crater, Arcadia hanging over it. Something nests in the hold.",
  },
];

export const WILD_SITE_BY_ID: ReadonlyMap<string, WildSiteDef> = new Map(WILD_SITES.map((s) => [s.id, s]));

export function wildSitesOn(body: BodyId): readonly WildSiteDef[] {
  return WILD_SITES.filter((s) => s.body === body);
}

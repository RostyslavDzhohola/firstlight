// Admin `stage <n>`: the five staged scenes for the video (SPEC §6.13, docs/staged-scenes.md).
// Teleports the admin plus the crew — other admins, load-test bots and members of the admin's
// party — within 80 m (or anywhere in the room with `all: true`) into a formation at the scene spot, heals them and sets the scene: boss and NPC
// spawns are requested on the event bus (`spawnRequest`, reason "stage") for the NPC lane to honour.
// If the admin is on another body the client is told to travel there and repeat the command.

import type { BodyId } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import { BOSS_LAIRS, placeDir, type BossId } from "@firstlight/shared/content/places";
import { maxHp } from "@firstlight/shared/content/progression";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, type PlayerActor } from "../actors.ts";
import { emitGameEvent } from "../events.ts";
import { dist3 } from "../geometry.ts";
import type { QuestSystem } from "./QuestSystem.ts";

export type Formation = "ring" | "line" | "arc" | "pair" | "duel";

export interface StageDef {
  n: number;
  body: BodyId;
  name: string;
  /** Scene centre: a place id, plus tangent offsets in metres. */
  place: string;
  east?: number;
  north?: number;
  formation: Formation;
  boss?: BossId;
  spawns?: { npcKind: string; count: number }[];
  /** Drop spawn protection (PvP scene). */
  unprotect?: boolean;
  /** Drop a staged loot pile in the middle. */
  pile?: { items: InvItem[]; coins: number };
  tip: string;
}

export const STAGES: readonly StageDef[] = [
  {
    n: 1, body: "portus", name: "Portus crowd under the sky planets", place: "portus_plaza", formation: "ring",
    tip: "Low camera in the ring's centre, tilt up to the three planets; slow orbit.",
  },
  {
    n: 2, body: "arcadia", name: "Arcadia vista: Tidewrath rising from the lake", place: "gull_point_overlook", formation: "line", boss: "tidewrath",
    tip: "Over-the-shoulder from the overlook down to Glasswater; hold until the coral spikes break the surface.",
  },
  {
    n: 3, body: "hollowmere", name: "Hollowmere chapel at dusk vs the Hollow Court", place: "drowned_chapel", north: -14, formation: "arc",
    spawns: [{ npcKind: "bonewalker", count: 4 }, { npcKind: "bone_archer", count: 2 }],
    tip: "Track along the arc at knee height; the chapel and the rising bones fill the frame.",
  },
  {
    n: 4, body: "meridian", name: "Meridian canyon co-op vs The Receiver", place: "foreclosure_yard", formation: "pair", boss: "receiver",
    tip: "Wide from the gantry, then cut between the two console holders as the hatch opens.",
  },
  {
    n: 5, body: "arcadia", name: "Wild-west PvP with destruction and a loot pile", place: "blockyard_camp", east: 60, formation: "duel", unprotect: true,
    pile: { items: [{ id: "comet", tier: 1, qty: 1 }, { id: "scatterpipe", tier: 1, qty: 1 }, { id: "tonic_small", tier: 1, qty: 3 }], coins: 150 },
    tip: "Two lines 20 m apart with the camp walls behind; the loot pile glows between them.",
  },
];

/** Formation offsets (east, north) in metres around the scene centre, for `count` people. */
export function formation(kind: Formation, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    switch (kind) {
      case "ring": {
        const a = (i / Math.max(1, count)) * Math.PI * 2;
        const r = 6 + Math.floor(i / 12) * 3;
        out.push([Math.cos(a) * r, Math.sin(a) * r]);
        break;
      }
      case "line":
        out.push([0, (i - (count - 1) / 2) * 2.5]);
        break;
      case "arc": {
        const a = ((i - (count - 1) / 2) / Math.max(1, count)) * 1.6;
        out.push([Math.sin(a) * 8, -Math.cos(a) * 8 + 8]);
        break;
      }
      case "pair":
        out.push([i % 2 === 0 ? -16 : 16, Math.floor(i / 2) * 2.5]);
        break;
      case "duel":
        out.push([(Math.floor(i / 2) - (Math.ceil(count / 2) - 1) / 2) * 3, i % 2 === 0 ? -10 : 10]);
        break;
    }
  }
  return out;
}

export function runStage(sys: QuestSystem, admin: PlayerActor, n: number, all: boolean) {
  const def = STAGES.find((s) => s.n === n);
  if (!def) {
    sys.toast(admin, `No stage ${n} (1–${STAGES.length})`, "warn");
    return;
  }
  if (sys.body !== def.body) {
    // Travel ticket for /api/play (admins are exempt, but keep the character's record straight).
    admin.char.travelTo = def.body;
    sys.room.saveActor(admin);
    admin.client.send("stage", { n, body: def.body });
    sys.toast(admin, `Stage ${n} is on ${def.body}: travelling…`, "info");
    return;
  }
  const here = actorPos(admin);
  const party = admin.state.party;
  const cast = [admin];
  for (const a of sys.room.actors.values()) {
    if (a === admin || a.dead) continue;
    const crew = a.identity.admin || a.identity.loadtest || (a.state.flags & (PF.ADMIN | PF.LOADTEST)) !== 0 || (!!party && a.state.party === party);
    if (crew && (all || dist3(actorPos(a), here) <= 80)) cast.push(a);
  }
  const centre = sys.around(placeDir(def.place), def.east ?? 0, def.north ?? 0);
  const spots = formation(def.formation, cast.length);
  // Boss pairs stand on the arena's real plates (Override Consoles / Tide Stones) when it has them.
  const plates = def.formation === "pair" ? (bossArena(sys.room.terrain)?.plates ?? []) : [];
  cast.forEach((a, i) => {
    const [e, nn] = spots[i]!;
    const plate = plates.length >= 2 ? plates[i % 2]! : null;
    sys.teleport(a, plate ? sys.around(plate, 0, Math.floor(i / 2) * 2) : sys.around(centre, e, nn));
    a.state.hp = a.state.maxHp = maxHp(a.char.level);
    if (def.unprotect) {
      a.protectedUntil = 0;
      a.state.flags &= ~PF.PROTECTED;
    }
    sys.toast(a, `Stage ${n}: ${def.name}`, "info");
  });
  const at = sys.room.snapToGround(centre);
  if (def.boss) {
    const lair = sys.room.snapToGround(placeDir(BOSS_LAIRS[def.boss].place));
    emitGameEvent(sys.room, { type: "spawnRequest", reason: "stage", bossId: def.boss, count: 1, pos: lair });
  }
  for (const s of def.spawns ?? []) emitGameEvent(sys.room, { type: "spawnRequest", reason: "stage", npcKind: s.npcKind, count: s.count, pos: at });
  if (def.pile) sys.room.createPile(admin, def.pile.items.map((i) => ({ ...i })), def.pile.coins, at);
  sys.toast(admin, `${cast.length} in scene · ${def.tip}`, "info");
}

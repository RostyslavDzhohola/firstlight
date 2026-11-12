// What an agent knows about a body without rendering it: the same shared terrain, solids, pads,
// portals, zones and world objects the server validates against and the browser client draws.

import { BODIES, bodyBreakables, createTerrain, natureSolids, padDirs, portalSpots, safeGates, zoneAt, inWalledZone, type BodyDef, type BodyId, type Breakable, type NatureSolids, type PortalSpot, type Terrain, type Zone } from "@firstlight/shared";
import { GUIDES, MISSION_BY_ID, missionsFrom, missionsOn, type MissionDef } from "@firstlight/shared/content/missions";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { NPC_AREAS } from "@firstlight/shared/content/npcs";
import { padName, placeDir, towardDir } from "@firstlight/shared/content/places";
import { SHOP_SPOTS, type ShopSpot } from "@firstlight/shared/content/shops";
import { objectPos, objectsOn, type WorldObjectDef } from "@firstlight/shared/content/world";
import { resolveAreaDir } from "@firstlight/shared/content/arenas";
import { BreakableCollider } from "@firstlight/shared/planet/collide";
import { structureCollider, type StructureCollider } from "@firstlight/shared/planet/sites";
import { deepWater } from "@firstlight/shared/planet/water";
import { groundDistance, norm, scale, type V3 } from "./vec.ts";

export interface WorldObject {
  def: WorldObjectDef;
  pos: V3;
}

export interface PadInfo {
  id: number;
  name: string;
  pos: V3;
}

const cache = new Map<BodyId, BodyWorld>();

/** The static world of one body (cached per process: terrain and solids are deterministic). */
export function bodyWorld(id: BodyId): BodyWorld {
  let w = cache.get(id);
  if (!w) cache.set(id, (w = new BodyWorld(id)));
  return w;
}

export class BodyWorld {
  readonly id: BodyId;
  readonly body: BodyDef;
  readonly terrain: Terrain;
  readonly R: number;
  /** Walls, houses, towers, pad platforms: never break. */
  readonly structures: StructureCollider;
  /** Tree trunks, boulders, spires, big rocks. */
  readonly nature: NatureSolids;
  /** Crates, fences, pillars…: solid until broken (the room's `broken` map says which are). */
  readonly breakables: BreakableCollider<Breakable>;
  readonly pads: readonly PadInfo[];
  readonly portals: readonly PortalSpot[];
  /** Things used with E (keepers, guides, mission pickups, puzzle parts). */
  readonly objects: readonly WorldObject[];
  readonly shops: readonly (ShopSpot & { at: V3 })[];
  readonly guide: WorldObject | null;
  /** Every world object of this body by id, the ones without an E prompt too (rings, shards, kite panels). */
  readonly things: ReadonlyMap<string, WorldObject>;
  /** Who hands out missions here: the planet's guide, or Sela Marchbank in Portus (the Three Gleams). */
  readonly givers: readonly WorldObject[];
  /** Sela Marchbank and the Gleam Vault (Portus only). */
  readonly curator: WorldObject | null;
  readonly vault: WorldObject | null;
  /** Gate centres of the walled safe zone (Portus town, a planet's arrival outpost), on the ground. */
  readonly gates: readonly V3[];
  /** Centre of the walled safe zone (unit direction), or null. */
  readonly walledCentre: V3 | null;

  constructor(id: BodyId) {
    this.id = id;
    this.body = BODIES[id];
    this.terrain = createTerrain(this.body);
    this.R = this.body.radius;
    this.structures = structureCollider(this.terrain);
    this.nature = natureSolids(this.terrain);
    this.breakables = new BreakableCollider<Breakable>(bodyBreakables(this.terrain));
    const hub = this.body.padLayout === "none";
    this.pads = hub ? [] : padDirs(this.body).map((d, i) => ({ id: i, name: padName(id, i), pos: this.onGround(d) }));
    this.portals = portalSpots(this.body, this.terrain);
    this.objects = objectsOn(id)
      .filter((o) => o.trigger === "interact")
      .map((def) => ({ def, pos: objectPos(def, (x, y, z) => this.terrain.groundHeight(x, y, z)) }));
    this.shops = SHOP_SPOTS.filter((s) => s.body === id).map((s) => ({ ...s, at: [s.pos[0], s.pos[1], s.pos[2]] as V3 }));
    this.guide = this.objects.find((o) => o.def.look === "guide") ?? null;
    this.things = new Map(objectsOn(id).map((def) => [def.id, { def, pos: objectPos(def, (x, y, z) => this.terrain.groundHeight(x, y, z)) }]));
    this.curator = this.objects.find((o) => o.def.id === GLEAMS.curator.id) ?? null;
    this.vault = this.objects.find((o) => o.def.id === GLEAMS.vault) ?? null;
    this.givers = this.objects.filter((o) => missionsFrom(o.def.id).length > 0);
    this.gates = safeGates(this.body).map((g) => this.onGround(g));
    this.walledCentre = hub ? [0, 1, 0] : this.gates.length ? norm(padDirs(this.body)[0]!) : null;
  }

  /** Ground height (metres above the radius) under a position of any length. */
  groundAt(p: readonly number[]): number {
    return this.terrain.groundHeightAt(p[0]!, p[1]!, p[2]!);
  }

  /** The point on the ground (or the swimming surface over deep water) under a direction or position. */
  onGround(p: readonly number[]): V3 {
    const d = norm(p);
    const g = this.terrain.groundHeight(d[0], d[1], d[2]);
    return scale(d, this.R + Math.max(g, this.body.waterLevel - 1.05));
  }

  /** Is the ground under `p` deep water (a swim, not a walk)? */
  deepAt(p: readonly number[]): boolean {
    return deepWater(this.groundAt(p), this.body.waterLevel);
  }

  zone(p: readonly number[]): Zone {
    return zoneAt(this.body, p[0]!, p[1]!, p[2]!);
  }

  walled(p: readonly number[]): boolean {
    return inWalledZone(this.body, p[0]!, p[1]!, p[2]!);
  }

  /** Can a body stand at `p` (feet on the ground): no wall, trunk or intact prop there, no deep water? */
  standable(p: readonly number[]): boolean {
    const q = { x: p[0]!, y: p[1]!, z: p[2]! };
    if (this.deepAt(p)) return false;
    if (!this.structures.isClear(q) || !this.nature.isClear(q)) return false;
    const c = { pushed: false, nx: 0, ny: 0, nz: 0, floor: 0 };
    return !this.breakables.list.length || !this.breakables.resolve({ ...q }, () => true, c);
  }

  /** The nearest way into a safe zone from `pos`: a point just inside a gate of the walled zone, or a pad. */
  safeSpot(pos: readonly number[]): { pos: V3; name: string } | null {
    let best: { pos: V3; name: string } | null = null;
    let bestD = Infinity;
    const centre = this.walledCentre;
    for (const g of this.gates) {
      const inside = centre ? this.onGround(towardDir(norm(g), centre, 12, this.R)) : g;
      const d = groundDistance(pos, inside);
      if (d < bestD) (bestD = d), (best = { pos: inside, name: this.id === "portus" ? "the town gate" : "the outpost gate" });
    }
    for (const p of this.pads) {
      if (centre && p.id === 0) continue; // the main pad is inside the walls: its gates stand for it
      const d = groundDistance(pos, p.pos);
      if (d < bestD) (bestD = d), (best = { pos: p.pos, name: `pad ${p.id} ${p.name}` });
    }
    return best;
  }

  /** The guide's name on this body (planets only). */
  guideName(): string | null {
    return id2guide(this.id)?.name ?? null;
  }

  /** Missions the guide of this body gives. */
  missions(): MissionDef[] {
    return missionsOn(this.id);
  }

  /**
   * Where a mission sends the player on this body, as a ground position: the hunt's place, the object
   * to pick up, or the place to reach. Null for a mission of another body or a hunt with no place.
   */
  missionSpot(missionId: string): { pos: V3; what: string; radius?: number } | null {
    const def = MISSION_BY_ID.get(missionId);
    if (!def || def.body !== this.id) return null;
    // Race, defend and collect: where an attempt starts (the agent narrows it to the next ring or the nearest piece).
    const first = def.race?.rings[0] ?? def.defend?.beacon ?? def.collect?.pieces[0];
    if (first) {
      const o = this.things.get(first);
      return o ? { pos: o.pos, what: def.race ? "the first ring (running through it starts the clock)" : def.defend ? `${o.def.name} (E), then stay within ${def.defend.radius} m` : `the first of the ${def.collect!.itemName}`, radius: def.race?.radius ?? def.collect?.radius ?? 3 } : null;
    }
    if (def.find) {
      const o = this.objects.find((x) => x.def.id === def.find!.object);
      return o ? { pos: o.pos, what: o.def.name } : null;
    }
    if (def.reach) return { pos: this.onGround(placeDir(def.reach.place)), what: `walk to within ${def.reach.radius} m of it`, radius: def.reach.radius };
    if (def.hunt?.place) {
      const area = NPC_AREAS.find((a) => a.id === def.hunt!.place);
      if (area && area.planet === this.id) return { pos: this.onGround(resolveAreaDir(this.body, area.at)), what: `${area.name}, the hunting ground (about ${area.radius} m across the middle)`, radius: area.radius };
      try {
        return { pos: this.onGround(placeDir(def.hunt.place)), what: "hunting ground" };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function id2guide(id: BodyId) {
  return id === "portus" ? null : GUIDES[id];
}

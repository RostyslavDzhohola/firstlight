// The food chain, first version (#15): forage → Woolbacks → Dusk Wolves. Each region cell of a planet
// (planet/regions.ts) keeps three numbers: its forage (0..1), its Woolbacks and its Dusk Wolves. Cells
// nobody is near run as numbers only (logistic grazers eating forage, a Holling type II predator that
// breeds toward what its prey can feed, a floor that
// wanderers refill and a ceiling, a slow pull toward the planet's mean); cells with real herds and
// packs awake hand the hunting to the real wolves (brain.ts `hunt`) and count real deaths. The herds
// and packs near players follow their cell: a herd spawns as many members as its cell's fill, a live
// herd gains members as its cell breeds, and a cleared herd or pack walks back in from nearby once its
// cell has animals to spare, never on a fixed timer at the spot it died. Camps, bosses, beasts, eggs
// and every other group keep their timers. Numbers: content/ecology.ts and docs/content.md.

import { ECO, ECO_GRAZER, ECO_PREDATOR } from "@firstlight/shared/content/ecology";
import { NPC_DEFS, NPC_RULES } from "@firstlight/shared/content/npcs";
import { regionCells, regionHit } from "@firstlight/shared/planet/regions";
import type { BodyId } from "@firstlight/shared";

export type EcoRole = "grazer" | "predator";

export interface EcoCell {
  /** Capacity: Woolbacks and Dusk Wolves the cell supports with nobody in it. */
  k: number;
  kp: number;
  /** Populations (fractional: a count the model moves smoothly) and forage 0..1. */
  w: number;
  p: number;
  f: number;
  /** Real herds or packs are awake here: the model leaves the hunting to them. */
  live: boolean;
  /** Players in the cell beyond the first (raises the capacity, ECO.crowdStep). */
  crowd: number;
}

export interface EcoTotals {
  w: number;
  p: number;
  k: number;
  kp: number;
  f: number;
  cells: number;
}

/** Fresh cells at the settled level the model starts from. */
export function newCell(k: number, kp: number): EcoCell {
  return { k, kp, w: 0.8 * k, p: 0.8 * kp, f: 0.6, live: false, crowd: 0 };
}

/** The capacity a cell has with `crowd` extra players in it. */
export function crowdK(c: EcoCell): number {
  return c.k * (1 + ECO.crowdStep * Math.min(ECO.crowdMax, c.crowd));
}

/**
 * Advance every cell by `dt` seconds (call with dt ≤ ECO.stepSeconds; longer spans in a loop). Pure
 * arithmetic on the cells; exported for the simulation test.
 */
export function stepCells(cells: EcoCell[], dt: number) {
  let sw = 0, sk = 0, sp = 0, skp = 0;
  for (const c of cells) {
    sw += c.w; sk += crowdK(c); sp += c.p; skp += c.kp;
  }
  const mw = sk > 0 ? sw / sk : 0, mp = skp > 0 ? sp / skp : 0;
  for (const c of cells) {
    const k = crowdK(c), kp = c.kp;
    const x = c.w / k;
    c.f += dt * (ECO.forageRegrow * c.f * (1 - c.f) + ECO.forageSeed * (1 - c.f) - ECO.graze * x * c.f);
    c.f = Math.min(1, Math.max(0, c.f));
    const kills = c.live ? 0 : (ECO.attack * c.p * x) / (x + ECO.halfFill);
    const births = ECO.birth * c.w * c.f * Math.max(0, 1 - x);
    const hunger = (ECO.starve * c.w * Math.max(0, ECO.hungerForage - c.f)) / ECO.hungerForage;
    c.w += dt * (births - hunger - kills + ECO.migrate * (mw * k - c.w));
    const fed = Math.max(0.05, kp * Math.min(1, x / ECO.fedFill));
    c.p += dt * (ECO.predBreed * c.p * (1 - c.p / fed) + ECO.convert * kills + ECO.migrate * (mp * kp - c.p));
    // Wanderers refill a cell below the floor; nothing grows past the ceiling.
    if (c.w < ECO.floor * k) c.w = Math.min(ECO.floor * k, Math.max(0, c.w) + dt * ECO.wanderIn * k);
    if (c.p < ECO.floor * kp) c.p = Math.min(ECO.floor * kp, Math.max(0, c.p) + dt * ECO.wanderIn * kp);
    c.w = Math.min(c.w, ECO.ceiling * k);
    c.p = Math.min(c.p, ECO.ceiling * kp);
  }
}

export function totals(cells: readonly EcoCell[]): EcoTotals {
  const t: EcoTotals = { w: 0, p: 0, k: 0, kp: 0, f: 0, cells: cells.length };
  for (const c of cells) {
    t.w += c.w; t.p += c.p; t.k += c.k; t.kp += c.kp; t.f += c.f;
  }
  if (cells.length) t.f /= cells.length;
  return t;
}

/** What the ecology needs to know of a spawn group (NpcSystem's GroupState). */
export interface EcoGroup {
  point: { id: number; kind: string; dir: readonly number[]; members: { def: number; golden?: boolean }[] };
  active: boolean;
  cleared: boolean;
}

const GRAZER = NPC_DEFS.findIndex((d) => d.id === ECO_GRAZER);
const PREDATOR = NPC_DEFS.findIndex((d) => d.id === ECO_PREDATOR);

/** A pack point of only Woolbacks (no egg critter) or only Dusk Wolves is in the chain; anything else isn't. */
export function ecoRoleOf(p: EcoGroup["point"]): EcoRole | null {
  if (p.kind !== "pack" || !p.members.length || p.members.some((m) => m.golden)) return null;
  if (p.members.every((m) => m.def === GRAZER)) return "grazer";
  if (p.members.every((m) => m.def === PREDATOR)) return "predator";
  return null;
}

export class Ecology {
  readonly cells: EcoCell[];
  /** Spawn point id → its cell and role (chain groups only). */
  readonly groups = new Map<number, { cell: number; role: EcoRole; slots: number }>();
  /** Herd / pack member slots per cell. */
  private readonly herdSlots: number[];
  private readonly packSlots: number[];
  private acc = 0;
  /** Model time since the last copy save was asked for (s). */
  private sinceSave = 0;
  /** Lifetime counters (the admin readout). */
  readonly counts = { playerKills: 0, predatorKills: 0, births: 0, returns: 0 };
  readonly body: BodyId;

  constructor(body: BodyId, groups: readonly EcoGroup[]) {
    this.body = body;
    const cells = regionCells(body);
    this.herdSlots = cells.map(() => 0);
    this.packSlots = cells.map(() => 0);
    for (const g of groups) {
      const role = ecoRoleOf(g.point);
      if (!role) continue;
      const d = g.point.dir;
      const cell = regionHit(body, d[0]!, d[1]!, d[2]!)!.cell;
      const slots = g.point.members.length;
      this.groups.set(g.point.id, { cell, role, slots });
      if (role === "grazer") this.herdSlots[cell]! += slots;
      else this.packSlots[cell]! += slots;
    }
    this.cells = cells.map((_, i) => newCell(Math.max(ECO.minGrazers, this.herdSlots[i]! * ECO.kPerSlot), Math.max(ECO.minPredators, this.packSlots[i]! * ECO.kPerSlot)));
  }

  /** Planets with any herd or pack in the chain. */
  get enabled(): boolean {
    return this.groups.size > 0;
  }

  roleOf(pointId: number): EcoRole | null {
    return this.groups.get(pointId)?.role ?? null;
  }

  /**
   * The share of a chain group's members its cell can fill now (0..1): the cell's population spread
   * over the herd (pack) slots in it.
   */
  fill(pointId: number): number {
    const e = this.groups.get(pointId);
    if (!e) return 1;
    const c = this.cells[e.cell]!;
    if (e.role === "grazer") return Math.min(1, c.w / Math.max(1, this.herdSlots[e.cell]!));
    return Math.min(1, c.p / Math.max(1, this.packSlots[e.cell]!));
  }

  /** Members a chain group should have out now. */
  want(pointId: number): number {
    const e = this.groups.get(pointId);
    if (!e) return Infinity;
    return Math.min(e.slots, Math.round(this.fill(pointId) * e.slots));
  }

  /**
   * How fast a cleared chain group's return countdown runs (×): stopped while its cell is near-empty,
   * the old timer's pace at the settled fill, a little faster when the cell is full.
   */
  returnRate(pointId: number): number {
    const f = this.fill(pointId);
    if (f < ECO.returnBelowFill) return 0;
    return Math.min(1.5, f / 0.75);
  }

  /** A chain animal died (a player or a wolf): its cell has one fewer. */
  onDeath(pointId: number, role: EcoRole, byPredator: boolean) {
    const e = this.groups.get(pointId);
    if (!e) return;
    const c = this.cells[e.cell]!;
    if (role === "grazer") {
      c.w = Math.max(0, c.w - 1);
      if (byPredator) {
        c.p = Math.min(ECO.ceiling * c.kp, c.p + ECO.convert);
        this.counts.predatorKills++;
      } else this.counts.playerKills++;
    } else {
      c.p = Math.max(0, c.p - 1);
      this.counts.playerKills++;
    }
  }

  /**
   * Called from the NPC scan with the time since the last one. `live(cell)` and `crowd(cell)` say
   * which cells have real chain groups awake and how many players stand in each. Returns true when
   * the copy's saved counts are worth refreshing (about once a minute of change).
   */
  tick(sdt: number, live: (cell: number) => boolean, crowd: (cell: number) => number): boolean {
    this.acc += sdt;
    if (this.acc < ECO.stepSeconds) return false;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i]!;
      c.live = live(i);
      c.crowd = crowd(i);
    }
    while (this.acc >= ECO.stepSeconds) {
      stepCells(this.cells, ECO.stepSeconds);
      this.acc -= ECO.stepSeconds;
      this.sinceSave += ECO.stepSeconds;
    }
    if (this.sinceSave >= 60) {
      this.sinceSave = 0;
      return true;
    }
    return false;
  }

  /** Run the numbers alone for `seconds` (a copy that was empty, the admin fast-forward). Capped at a day. */
  advance(seconds: number) {
    let left = Math.min(86_400, Math.max(0, seconds));
    for (const c of this.cells) {
      c.live = false;
      c.crowd = 0;
    }
    while (left > 0) {
      const dt = Math.min(30, left);
      stepCells(this.cells, dt);
      left -= dt;
    }
  }

  /** Saved with the copy (persist.ts): w, p, f per cell, to two decimals. */
  snapshot(): number[] {
    const out: number[] = [];
    for (const c of this.cells) out.push(Math.round(c.w * 100) / 100, Math.round(c.p * 100) / 100, Math.round(c.f * 100) / 100);
    return out;
  }

  /** Apply a snapshot, then run the time the copy was empty. A save from another layout is ignored. */
  restore(s: unknown, awaySeconds: number) {
    if (!Array.isArray(s) || s.length !== this.cells.length * 3 || !s.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return;
    this.cells.forEach((c, i) => {
      c.w = Math.min(ECO.ceiling * crowdK(c), s[i * 3] as number);
      c.p = Math.min(ECO.ceiling * c.kp, s[i * 3 + 1] as number);
      c.f = Math.min(1, s[i * 3 + 2] as number);
    });
    if (awaySeconds > 0) this.advance(awaySeconds);
  }

  /** One line for the admin readout and the server log. */
  summary(): string {
    const t = totals(this.cells);
    return `eco ${this.body}: woolbacks ${t.w.toFixed(1)}/${t.k.toFixed(0)} wolves ${t.p.toFixed(1)}/${t.kp.toFixed(0)} forage ${(t.f * 100).toFixed(0)}% · kills player ${this.counts.playerKills} wolf ${this.counts.predatorKills} · births ${this.counts.births} returns ${this.counts.returns}`;
  }

  /** A cell's numbers (the admin readout for the cell a player stands in). */
  cellAt(x: number, y: number, z: number): { cell: number; w: number; p: number; f: number; k: number; kp: number } | null {
    const h = regionHit(this.body, x, y, z);
    if (!h) return null;
    const c = this.cells[h.cell]!;
    return { cell: h.cell, w: c.w, p: c.p, f: c.f, k: crowdK(c), kp: c.kp };
  }
}

/** The old fixed timer a chain group's return countdown starts from. */
export const ECO_RETURN_SECONDS = NPC_RULES.respawnPack;

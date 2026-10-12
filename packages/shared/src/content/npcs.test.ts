import { describe, expect, it } from "vitest";
import { BODIES, isSafe, padDirs } from "../index.ts";
import { createTerrain } from "../planet/terrain.ts";
import { bossArena } from "./arenas.ts";
import {
  AI_CAPS, BOSS_DEFS, HEAVY_RECOVERY_FLOOR, HEAVY_SHARE, LETHAL_SHARE, NPC_AREAS, NPC_DEFS, NPC_INDEX, PLANET_WILDS, TELEGRAPH_FLOORS,
  aiHitCap, attackDamage, bossMaxHp, hitShare, npcCoins, npcDef, npcMaxHp, splitDamage, weaponTierFor,
} from "./npcs.ts";
import { maxHp } from "./progression.ts";
import { WEAPON_BY_ID } from "./weapons.ts";

describe("npc roster", () => {
  it("indexes every def by id (NpcState.kind)", () => {
    expect(NPC_INDEX.size).toBe(NPC_DEFS.length);
    NPC_DEFS.forEach((d, i) => expect(NPC_INDEX.get(d.id)).toBe(i));
  });

  it("every attack respects the telegraph floors", () => {
    for (const d of NPC_DEFS) {
      for (const a of d.attacks) {
        const where = `${d.id}.${a.id}`;
        expect(a.telegraph, where).toBeGreaterThanOrEqual(TELEGRAPH_FLOORS[a.weight]);
        if (a.weight !== "light") expect(a.recovery, where).toBeGreaterThanOrEqual(HEAVY_RECOVERY_FLOOR);
        if (a.trueDamage) continue;
        const share = hitShare(d, a);
        // Hits ≥ 20% of on-level HP are heavy (0.9 s); boss hits ≥ 40% are lethal-tier (1.2 s).
        if (share >= HEAVY_SHARE) expect(a.telegraph, where).toBeGreaterThanOrEqual(TELEGRAPH_FLOORS.heavy);
        if (d.tier === "boss" && share >= LETHAL_SHARE) expect(a.telegraph, where).toBeGreaterThanOrEqual(TELEGRAPH_FLOORS.lethal);
      }
    }
  });

  it("every single hit stays under the AI hit caps at the top of its level range", () => {
    for (const d of NPC_DEFS) {
      for (const a of d.attacks) {
        if (a.trueDamage) continue;
        const cap = d.tier === "boss" ? AI_CAPS.boss : AI_CAPS.regular;
        expect(hitShare(d, a), `${d.id}.${a.id}`).toBeLessThanOrEqual(cap + 1e-9);
      }
    }
    expect(aiHitCap("regular", 200)).toBe(70);
    expect(aiHitCap("boss", 200)).toBe(120);
  });

  it("split circles kill a lone player and deal exactly 60% each to two on-level players", () => {
    for (const d of NPC_DEFS.filter((x) => x.tier === "boss")) {
      for (const a of d.attacks.filter((x) => x.trueDamage)) {
        const hp = maxHp(d.levels[1]);
        expect(attackDamage(a, d.levels[1]) / hp, `${d.id}.${a.id}`).toBeGreaterThanOrEqual(1.19);
        expect(splitDamage(a.damage, 2) / hp).toBeCloseTo(0.6, 2);
        expect(splitDamage(a.damage, 0)).toBe(a.damage);
      }
    }
  });

  it("HP and damage match the content tables at the ends of each level range", () => {
    expect(npcMaxHp(npcDef("hopbit"), 1)).toBe(22);
    expect(npcMaxHp(npcDef("bramblehorn"), 8)).toBe(1656);
    expect(npcMaxHp(npcDef("fenstalker"), 14)).toBe(2560);
    expect(npcMaxHp(npcDef("dunebreaker"), 20)).toBe(3936);
    expect(npcMaxHp(npcDef("cabinet_golem"), 6)).toBe(416);
    expect(npcMaxHp(npcDef("crypt_sentinel"), 13)).toBe(415);
    expect(Math.round(attackDamage(npcDef("pixel_lancer").attacks[0]!, 7))).toBe(36);
    expect(Math.round(attackDamage(npcDef("dusk_wolf").attacks[0]!, 19))).toBe(41);
    expect(npcCoins(npcDef("bramblehorn"), 8)).toBe(126);
    expect(npcCoins(npcDef("woolback"), 1)).toBe(0);
    expect(npcCoins(npcDef("hopbit"), 4)).toBe(5);
  });

  it("boss HP scales with engaged players (HP₂ for 1–2, +35% each extra, capped at 8)", () => {
    expect(bossMaxHp(12_000, 1)).toBe(12_000);
    expect(bossMaxHp(12_000, 3)).toBe(16_200);
    expect(bossMaxHp(28_000, 4)).toBe(47_600);
    expect(bossMaxHp(30_000, 3)).toBe(40_500);
    expect(bossMaxHp(12_000, 20)).toBe(bossMaxHp(12_000, 8));
  });

  it("weapon tiers follow enemy level", () => {
    expect(weaponTierFor(5, 0.99)).toBe(1);
    expect(weaponTierFor(8, 0.1)).toBe(1);
    expect(weaponTierFor(8, 0.5)).toBe(2);
    expect(weaponTierFor(15, 0.1)).toBe(2);
    expect(weaponTierFor(15, 0.9)).toBe(3);
  });

  it("spawn tables only reference known defs and drop known or listed items", () => {
    for (const area of NPC_AREAS) {
      for (const g of area.groups) for (const m of g.members) expect(NPC_INDEX.has(m.kind), `${area.id}:${m.kind}`).toBe(true);
      for (const m of area.camp?.members ?? []) expect(NPC_INDEX.has(m.kind)).toBe(true);
      for (const s of area.singles ?? []) expect(NPC_INDEX.has(s.kind)).toBe(true);
    }
    for (const w of Object.values(PLANET_WILDS)) for (const g of w.groups) for (const m of g.members) expect(NPC_INDEX.has(m.kind)).toBe(true);
    for (const b of BOSS_DEFS) expect(npcDef(b.id).family).toBe("boss");
    for (const d of NPC_DEFS) for (const r of d.drops) if (r.kind === "item" && r.id.startsWith("tonic")) expect(WEAPON_BY_ID.has(r.id)).toBe(true);
  });
});

describe("boss arenas", () => {
  for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`${id}: lair on dry ground, out of every safe ring, plates ≥ 25 m apart`, () => {
      const body = BODIES[id];
      const t = createTerrain(body);
      const a = bossArena(t)!;
      expect(a).toBeTruthy();
      const R = body.radius;
      const h = (p: number[]) => Math.hypot(p[0]!, p[1]!, p[2]!) - R;
      expect(h(a.centre)).toBeGreaterThan(body.waterLevel);
      expect(isSafe(body, ...a.centre)).toBe(false);
      for (const p of padDirs(body)) expect(Math.hypot(p[0] * R - a.centre[0], p[1] * R - a.centre[1], p[2] * R - a.centre[2])).toBeGreaterThan(a.radius + 40);
      if (a.plates.length) {
        expect(a.plates.length).toBe(2);
        const p = a.plates[0]!, q = a.plates[1]!;
        expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeGreaterThanOrEqual(25);
        for (const pl of a.plates) expect(h(pl)).toBeGreaterThan(body.waterLevel);
      }
      // Deterministic: the client computes the same layout.
      const again = bossArena(createTerrain(body))!;
      expect(again.plates).toEqual(a.plates);
      expect(again.home).toEqual(a.home);
    });
  }
});

import { describe, expect, it } from "vitest";
import { STARTERS, weapon, WEAPONS } from "@firstlight/shared/content/weapons";
import { PRESETS } from "./presets.ts";
import { SOUNDS } from "../../../../tools/sfx/sounds.ts";
import { attackSound, fallbackOf, impactSound, SAMPLE_FALLBACKS, SAMPLE_NAMES, swingSound } from "./sounds.ts";

describe("sound mapping", () => {
  it("gives every sample a ZzFX stand-in that exists", () => {
    for (const name of SAMPLE_NAMES) expect(PRESETS).toHaveProperty(SAMPLE_FALLBACKS[name].preset);
  });

  it("gives the starter weapons their own sounds: sword swish, staff whoosh, wand cast, blaster shot, fists", () => {
    const starter = Object.fromEntries(STARTERS.map((s) => [s.id, weapon(s.weapon)]));
    expect(attackSound(starter.ash)).toBe("swing_sword");
    expect(attackSound(starter.kappa)).toBe("swing_staff");
    expect(attackSound(starter.hexwick)).toBe("hexquill");
    expect(attackSound(starter.unit7)).toBe("carbine");
    expect(attackSound(weapon("fists"))).toBe("swing_fists");
    expect(attackSound(undefined)).toBe("swing_fists"); // empty slot
    expect(swingSound("fists")).toBe("swing_fists");
    expect(swingSound("axe")).toBe("swing_heavy");
  });

  it("maps every attacking weapon to a sound of its own kind", () => {
    for (const w of WEAPONS) {
      const s = attackSound(w);
      if (w.delivery === "melee") expect(s, w.id).toMatch(/^swing_/);
      else if (["hitscan", "pellets", "chain", "projectile", "arrow", "thrown"].includes(w.delivery)) expect(s, w.id).toBe(w.id);
    }
  });

  it("gives weapons appended later the sound of their delivery until they get their own", () => {
    expect(attackSound({ id: "new_blade", cls: "melee", delivery: "melee" })).toBe("swing_sword");
    expect(attackSound({ id: "new_kunai", cls: "ranged", delivery: "thrown" })).toBe("grenade");
    expect(attackSound({ id: "new_fireball", cls: "magic", delivery: "projectile" })).toBe("hexquill");
    expect(attackSound({ id: "new_rocket", cls: "ranged", delivery: "projectile" })).toBe("comet");
    expect(attackSound({ id: "new_rifle", cls: "ranged", delivery: "hitscan" })).toBe("carbine");
    expect(swingSound(undefined)).toBe("swing_sword");
  });

  it("lands magic bolts with a magic hit and everything else with a plain impact", () => {
    expect(impactSound(weapon("hexquill"))).toBe("magic_hit");
    expect(impactSound(weapon("emberglass"))).toBe("magic_hit");
    expect(impactSound(weapon("longbow"))).toBe("impact");
    expect(impactSound(undefined)).toBe("impact");
  });

  it("no longer pings: the hit marker and UI stand-ins are low and short", () => {
    for (const name of ["hitmark", "ui"] as const) {
      const p = PRESETS[fallbackOf(name).preset];
      expect(p[2], name).toBeLessThanOrEqual(600); // frequency (was 1.6 kHz and 900 Hz)
      expect((p[4] ?? 0) + (p[5] ?? 0.1), name).toBeLessThan(0.06); // sustain + release (s)
    }
  });

  it("has a generation spec for every sample, and 2+ kept takes for the frequent ones", () => {
    expect(SOUNDS.map((s) => s.name).sort()).toEqual([...SAMPLE_NAMES].sort());
    const frequent = ["hitmark", "crit", "ui", "impact", "hurt", "swing_sword", "swing_staff", "swing_fists", "hexquill", "magic_hit", "carbine"];
    for (const s of SOUNDS.filter((s) => frequent.includes(s.name))) {
      const kept = s.prompts.length - Object.keys(s.drop ?? {}).length;
      expect(kept, s.name).toBeGreaterThanOrEqual(2);
    }
  });
});

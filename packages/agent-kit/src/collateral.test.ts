// `pvp: false` and the people around a fight (review 2026-11-12 agent kit #3): a player in the
// weapon's melee arc, on a projectile's path or in a splash radius holds the attack.

import { describe, expect, it } from "vitest";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { attackShape, bystanderAtRisk, type AttackShape, type Bystander } from "./collateral.ts";
import { addScaled, cross, norm, tangent, type V3 } from "./vec.ts";

const R = 600;
const pos: V3 = [0, R, 0];
const up = norm(pos);
const fwd = tangent(up, [1, 0, 0])!;
const left = norm(cross(up, fwd));
const head = addScaled(pos, up, 1.6);
/** A point `ahead` metres in front and `side` metres to the left, on the ground. */
const at = (ahead: number, side = 0): V3 => addScaled(addScaled(pos, fwd, ahead), left, side);
const who = (ahead: number, side = 0): Bystander[] => [{ id: "h", name: "Human", p: at(ahead, side) }];
const chestOf = (p: V3): V3 => addScaled(p, up, 1);
const weapon = (id: string) => WEAPONS.find((w) => w.id === id)!;
const shape = (id: string): AttackShape => attackShape(weapon(id), weapon(id).tiers[0]!);

describe("bystanders: melee", () => {
  const sword = shape("sunbrand"); // 2.4 m, 110 degrees
  const creature = chestOf(at(1.8));
  it("a player in the arc holds the swing, wherever the creature is", () => {
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(2.0, 0.8))?.name).toBe("Human");
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(1.0))).not.toBeNull(); // nearer than the creature: the hit would be theirs
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(0.2, 0.2))).not.toBeNull(); // on top of us
  });
  it("a player behind us or out of reach doesn't", () => {
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(-2))).toBeNull();
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(0, 3))).toBeNull(); // square to the side, past the padded arc
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, who(6))).toBeNull();
    expect(bystanderAtRisk(sword, pos, head, fwd, creature, [])).toBeNull();
  });
});

describe("bystanders: shots", () => {
  const quill = shape("hexquill"); // 40 m, no splash
  const creature = chestOf(at(12));
  it("a player on the projectile's path holds the shot: in front of the creature, or behind it where a miss flies on", () => {
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(6, 0.3))).not.toBeNull();
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(25, 0.5))).not.toBeNull();
  });
  it("a player well off the line, behind us, or past the weapon's range doesn't", () => {
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(6, 4))).toBeNull();
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(-5))).toBeNull();
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(60))).toBeNull();
  });
  it("a splash weapon also holds for a player in the blast, off the line", () => {
    const ember = shape("emberglass");
    expect(ember.blast).toBeGreaterThan(0);
    expect(bystanderAtRisk(ember, pos, head, fwd, creature, who(12, 3))).not.toBeNull(); // 3 m beside the creature: inside radius + margin
    expect(bystanderAtRisk(quill, pos, head, fwd, creature, who(12, 3))).toBeNull(); // the same spot is safe from a weapon without splash
    expect(bystanderAtRisk(ember, pos, head, fwd, creature, who(12, 8))).toBeNull();
  });
  it("pellets spread, a chain jumps, a thrown charge bursts: each holds for a player its own shape reaches", () => {
    const pipe = shape("scatterpipe"); // 7 degrees of spread
    expect(bystanderAtRisk(pipe, pos, head, fwd, chestOf(at(8)), who(8, 1.8))).not.toBeNull();
    expect(bystanderAtRisk(quill, pos, head, fwd, chestOf(at(8)), who(8, 1.8))).toBeNull();
    expect(bystanderAtRisk(shape("stormcoil"), pos, head, fwd, creature, who(12, 6))).not.toBeNull();
    const thrown = WEAPONS.find((w) => w.delivery === "thrown")!;
    expect(attackShape(thrown, thrown.tiers[0]!).blast).toBe(thrown.tiers[0]!.radius);
  });
});

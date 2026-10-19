import { describe, expect, it } from "vitest";
import { attackDeniedText, holsteredText, immuneText, NoticeGate } from "./notices.ts";
import { dummyTargets } from "./onboardingTargets.ts";
import { dummyDir } from "@firstlight/shared/content/onboarding";

describe("attack refusal notices", () => {
  it("say why the server refused a shot or a swing", () => {
    expect(attackDeniedText("fire", "safe zone")).toBe("Weapons are holstered in safe zones");
    expect(attackDeniedText("fire", "safe zone", "portus")).toMatch(/in town: head out of the gates/);
    expect(attackDeniedText("melee", "safe zone", "arcadia")).toMatch(/on the pad: step out of the ring/);
    expect(attackDeniedText("melee", "safe zone")).toBe("Weapons are holstered in safe zones");
    expect(attackDeniedText("fire", "protected")).toMatch(/protection/);
    expect(attackDeniedText("fire", "overheated")).toMatch(/Overheated/);
    expect(attackDeniedText("melee", "swimming")).toMatch(/swimming/);
  });

  it("stay quiet for other actions and for reasons players needn't see", () => {
    expect(attackDeniedText("use", "safe zone")).toBeNull();
    expect(attackDeniedText("fire", "rate")).toBeNull();
    expect(attackDeniedText("melee", "not charged")).toBeNull();
  });

  it("show once per press: a sustained refusal stream shows one notice; a new reason at once; a new press again", () => {
    const gate = new NoticeGate();
    // Holding the carbine through arrival protection: a refusal every 0.25 s for 5 s.
    let shown = 0;
    for (let i = 0; i < 20; i++) if (gate.allow("Arrival protection")) shown++;
    expect(shown).toBe(1);
    expect(gate.allow("Overheated")).toBe(true); // another reason in the same hold
    expect(gate.allow("Overheated")).toBe(false);
    // Released: refusals of that hold still arriving stay quiet.
    expect(gate.allow("Arrival protection")).toBe(false);
    gate.press(); // a new press
    expect(gate.allow("Arrival protection")).toBe(true);
    expect(gate.allow("Arrival protection")).toBe(false);
  });

  it("say why a hit did nothing (the server's immune reasons)", () => {
    for (const r of ["spawning", "evading", "invulnerable", "shield", "arena"]) expect(immuneText(r)).toBeTruthy();
    expect(immuneText("other")).toBeNull();
  });
});

describe("the dummy step's guidance (#31)", () => {
  it("in town during the dummy step, a swing away from the dummies points at them, not out of the gates", () => {
    expect(holsteredText("portus", true)).toBe("Training: swing at a dummy (follow the marker)");
    expect(holsteredText("portus")).toBe("Weapons are holstered in town: head out of the gates to fight");
  });

  it("marks each dummy still standing on the map while the dummy step is on, and nothing otherwise", () => {
    expect(dummyTargets("attack", [false, true, false])).toEqual([
      { id: "dummy:0", dir: dummyDir(0), label: "Training dummy" },
      { id: "dummy:2", dir: dummyDir(2), label: "Training dummy" },
    ]);
    expect(dummyTargets("attack", [true, true, true])).toEqual([]);
    expect(dummyTargets("sprint", [false, false, false])).toEqual([]);
    expect(dummyTargets(undefined, [false, false, false])).toEqual([]);
  });
});

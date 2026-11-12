import { describe, expect, it } from "vitest";
import { attackDeniedText, holsteredText, immuneText, NoticeGate } from "./notices.ts";
import { dummyCalloutSub, dummyTargets, nextDummy } from "./onboardingTargets.ts";
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
    // The server's own "safe zone" refusal reads the same during the step.
    expect(attackDeniedText("melee", "safe zone", "portus", true)).toBe("Training: swing at a dummy (follow the marker)");
  });

  it("marks each dummy still standing on the map while the dummy step is on (one label for the cluster), and nothing otherwise", () => {
    expect(dummyTargets("attack", [false, true, false])).toEqual([
      { id: "dummy:0", dir: dummyDir(0), label: "Training dummies (2)" },
      { id: "dummy:2", dir: dummyDir(2), label: "" },
    ]);
    expect(dummyTargets("attack", [false, false, false]).filter((t) => t.label).map((t) => t.label)).toEqual(["Training dummies (3)"]);
    expect(dummyTargets("attack", [true, true, false])).toEqual([{ id: "dummy:2", dir: dummyDir(2), label: "Training dummy" }]);
    expect(dummyTargets("attack", [true, true, true])).toEqual([]);
    expect(dummyTargets("sprint", [false, false, false])).toEqual([]);
    expect(dummyTargets(undefined, [false, false, false])).toEqual([]);
  });
});

describe("the dummy step's world marker (#31, Codex review)", () => {
  it("points at the nearest dummy still standing, and at nothing once all are down", () => {
    const near = (i: number) => dummyDir(i) as unknown as [number, number, number];
    expect(nextDummy([false, false, false], near(2))).toBe(2);
    expect(nextDummy([false, false, true], near(2))).toBe(1);
    expect(nextDummy([true, false, true], near(0))).toBe(1);
    expect(nextDummy([true, true, true], near(1))).toBeNull();
  });
});

describe("the dummy callout says how far the next dummy is (#31)", () => {
  it("only the rules up close; the distance, rounded to 5 m, once the player is off", () => {
    expect(dummyCalloutSub(4)).toBe("10 XP each. Three hits knock one down.");
    expect(dummyCalloutSub(13)).toBe("15 m away · 10 XP each. Three hits knock one down.");
    expect(dummyCalloutSub(88)).toBe("90 m away · 10 XP each. Three hits knock one down.");
    expect(dummyCalloutSub(Number.NaN)).toBe("10 XP each. Three hits knock one down.");
  });
});

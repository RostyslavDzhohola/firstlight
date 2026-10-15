import { describe, expect, it } from "vitest";
import { attackDeniedText, NoticeGate } from "./notices.ts";

describe("attack refusal notices", () => {
  it("say why the server refused a shot or a swing", () => {
    expect(attackDeniedText("fire", "safe zone")).toBe("Weapons are holstered in safe zones");
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
});

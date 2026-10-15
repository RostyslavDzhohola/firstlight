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

  it("don't repeat while the button is held, but a new reason shows at once", () => {
    const gate = new NoticeGate(1500);
    expect(gate.allow("Overheated", 0)).toBe(true);
    expect(gate.allow("Overheated", 400)).toBe(false);
    expect(gate.allow("Reloading…", 500)).toBe(true);
    expect(gate.allow("Overheated", 600)).toBe(true);
    expect(gate.allow("Overheated", 2200)).toBe(true);
  });
});

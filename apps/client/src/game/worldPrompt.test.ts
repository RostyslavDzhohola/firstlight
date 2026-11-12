import { describe, expect, it } from "vitest";
import { worldPrompt } from "./worldPrompt.ts";

const vault = { id: "gleam_vault", look: "vault" as const, name: "Open the Gleam Vault" };

describe("world prompts (D-polish-ux-5)", () => {
  it("the Gleam Vault counts gleams until it can open", () => {
    expect(worldPrompt(vault, null)).toBe("E — Gleam Vault · 0 of 3 gleams");
    expect(worldPrompt(vault, { missions: [{ id: "T1", done: true }, { id: "T2", done: false }] })).toBe("E — Gleam Vault · 1 of 3 gleams");
    expect(worldPrompt(vault, { missions: ["T1", "T2", "T3"].map((id) => ({ id, done: true })) })).toBe("E — Open the Gleam Vault");
  });

  it("people and other objects keep their prompts", () => {
    expect(worldPrompt({ id: "curator_sela", look: "curator", name: "Sela Marchbank" }, null)).toBe("E — Talk to Sela Marchbank");
    expect(worldPrompt({ id: "x", look: "lantern", name: "Light the lantern" }, null)).toBe("E — Light the lantern");
  });
});

// @vitest-environment happy-dom
// The tutorial's end card stays up across the portal; on arrival its "Next" names the planet's guide,
// not the portal left behind (play-through 2026-11-14).
import { describe, expect, it } from "vitest";
import { OnboardingHud } from "./onboarding.ts";

describe("the end card after the portal", () => {
  it("says to talk to the guide, and drops the portal's way row", () => {
    const hud = new OnboardingHud(document.body, () => {});
    hud.showDone(50);
    hud.setWay({ label: "Arcadia portal", deg: 0, metres: 2 } as never);
    expect(hud.root.textContent).toContain("walk into the Arcadia portal");
    hud.arrived("Arcadia", "Lark");
    const text = hud.root.textContent ?? "";
    expect(text).toContain("talk to Lark by the pad");
    expect(text).not.toContain("walk into the");
    expect(hud.root.querySelector('[data-e2e="onboarding-way"]')).toBeNull();
    hud.dispose();
  });
});

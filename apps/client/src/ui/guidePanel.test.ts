// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import type { Game } from "../game/Game.ts";
import { GuidePanel, guideBody } from "./panels.ts";

/** Just enough of Game for a panel to open, render and send. */
function fakeGame(you: unknown = null) {
  const sent: [string, unknown][] = [];
  const game = {
    hud: { you },
    input: { enabled: true, clearKeys() {}, lock() {} },
    net: { room: { send: (type: string, msg: unknown) => sent.push([type, msg]) } },
  };
  return { game: game as unknown as Game, sent };
}

const cards = (p: GuidePanel) => [...p.box.querySelectorAll(".mission")].map((c) => c.querySelector("b")!.textContent);

describe("guide panels (sky review 2 and 3)", () => {
  let open: GuidePanel | null = null;
  afterEach(() => open?.close(false));

  it("Lark offers the moon mission L1 after her own four, and Accept sends it", () => {
    const { game, sent } = fakeGame();
    open = new GuidePanel(game, "arcadia");
    open.open();
    expect(cards(open)).toContain("The Thing in the Wreck");
    expect(cards(open)).toHaveLength(5);
    expect(cards(open).at(-1)).toBe("The Thing in the Wreck");
    const l1 = [...open.box.querySelectorAll(".mission")].find((c) => c.textContent!.includes("The Thing in the Wreck"))!;
    (l1.querySelector("button.btn") as HTMLButtonElement).click();
    expect(sent).toEqual([["mission", { action: "accept", id: "L1" }]]);
  });

  it("every body but Portus has a guide whose panel opens; Portus has none", () => {
    expect(BODY_IDS.filter((b) => guideBody(b))).toEqual(["arcadia", "hollowmere", "meridian", "lumen"]);
    expect(guideBody("portus")).toBe(false);
  });

  it("Surveyor Odile's panel opens on Lumen and shows the moon's mission, with no Accept (Lark gives it)", () => {
    const { game } = fakeGame({ missions: [{ id: "L1", progress: 2, goal: 5, done: false }] });
    open = new GuidePanel(game, "lumen" as BodyId as Exclude<BodyId, "portus">);
    open.open();
    expect(open.box.querySelector("h2")!.textContent).toBe("SURVEYOR ODILE");
    expect(cards(open)).toEqual(["The Thing in the Wreck"]);
    expect(open.box.textContent).toContain("2 / 5");
    expect(open.box.textContent).toContain("Lark");
    expect(open.box.querySelector(".mission button.btn:not(.ghost)")).toBeNull();
  });
});

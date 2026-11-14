// @vitest-environment happy-dom
// Review 2026-11-13 #4: how a pad and a touch screen collapse the missions panel and track a mission,
// driven through the real controls (the earlier coverage note claimed Settings → Missions collapses
// the panel; that setting hides it).
// - Pad: the pause menu's Journal row (KeyJ) opens the journal; the gamepad focus navigator reaches its
//   Missions tab's Track buttons and the "Fold the missions panel" button, and A clicks them.
// - Touch: the panel's header and its rows are real buttons that take taps; the journal is in the touch
//   pause menu too.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MENU_KEY_ROWS } from "../game/padMapping.ts";
import { missionTrack } from "../game/missionTrack.ts";
import { FocusNav, reachable } from "./focusNav.ts";
import { MissionsPanel } from "./missionsPanel.ts";
import { JournalPanel, Panel } from "./panels.ts";
import { trackerRows } from "./trackerRows.ts";
import { uiSettings } from "./uiSettings.ts";

const MISSIONS = [{ id: "A1", progress: 0, done: false, goal: 8 }, { id: "A3", progress: 0, done: false, goal: 1 }];

function fakeGame() {
  return {
    input: { enabled: true, clearKeys() {}, device: "pad" },
    hud: { you: { missions: MISSIONS, level: 3, title: null, inventory: [], cosmetics: [], medals: [] }, starterIndex: 0 },
    net: { room: null },
    bodyId: "arcadia",
  } as never;
}

// happy-dom has no layout: give connected elements a box so the navigator's visibility and on-screen
// tests behave as in a browser; [hidden], disabled and inert are still the real checks.
const realRects = HTMLElement.prototype.getClientRects;
const realBox = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    return (this.isConnected ? [new DOMRect(10, 10, 10, 10)] : []) as unknown as DOMRectList;
  };
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.isConnected ? new DOMRect(10, 10, 10, 10) : new DOMRect();
  };
  localStorage.clear();
  uiSettings.reset();
  missionTrack.choose("A1");
});
afterEach(() => {
  HTMLElement.prototype.getClientRects = realRects;
  HTMLElement.prototype.getBoundingClientRect = realBox;
  Panel.current?.close(false);
  document.body.replaceChildren();
  uiSettings.reset();
  missionTrack.choose(null);
});

describe("the pad reaches missions through the pause menu's Journal", () => {
  it("has a Journal row (KeyJ) in the pause menu for pads and touch", () => {
    const journal = MENU_KEY_ROWS.find((r) => r.code === "KeyJ")!;
    expect(journal.on).toEqual(expect.arrayContaining(["pad", "touch"]));
  });

  it("A on the journal's Track button tracks that mission", () => {
    const j = new JournalPanel(fakeGame());
    j.show("missions");
    const nav = new FocusNav(document);
    const track = reachable(document).find((e) => e.dataset.e2e === "journal-track-A3")!;
    expect(track).toBeTruthy();
    nav.focus(track);
    nav.accept();
    expect(missionTrack.chosen).toBe("A3");
  });

  it("A on 'Fold the missions panel' collapses the HUD panel, and again unfolds it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const hudPanel = new MissionsPanel(host);
    hudPanel.set(trackerRows(MISSIONS, "arcadia", { tracked: missionTrack.chosen }).lines, "Lark · Arcadia");
    expect(hudPanel.root.querySelectorAll(".fl-mission").length).toBe(2);
    const j = new JournalPanel(fakeGame());
    j.show("missions");
    const nav = new FocusNav(document);
    const fold = () => reachable(document).find((e) => e.dataset.e2e === "journal-fold-missions")!;
    expect(fold().textContent).toMatch(/Fold the missions panel/);
    nav.focus(fold());
    nav.accept();
    expect(uiSettings.get().missionsCollapsed).toBe(true);
    expect(hudPanel.root.querySelectorAll(".fl-mission").length).toBe(0);
    expect(fold().textContent).toMatch(/Unfold/);
    nav.focus(fold());
    nav.accept();
    expect(uiSettings.get().missionsCollapsed).toBe(false);
    hudPanel.dispose();
  });
});

describe("touch taps the panel itself", () => {
  it("a tap on the header folds it; a tap on a row tracks that mission", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const p = new MissionsPanel(host);
    p.set(trackerRows(MISSIONS, "arcadia", { tracked: missionTrack.chosen }).lines, "Lark · Arcadia");
    const row = p.root.querySelector<HTMLElement>('[data-e2e="mission-row-A3"]')!;
    expect(row.tagName).toBe("BUTTON"); // takes taps above the touch layer (hud.css: button.fl-mission)
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    row.click();
    expect(missionTrack.chosen).toBe("A3");
    const header = p.root.querySelector<HTMLButtonElement>('[data-e2e="missions-toggle"]')!;
    expect(header.classList.contains("hit-area")).toBe(true); // .fl-hud .hit-area takes pointer events
    header.click();
    expect(uiSettings.get().missionsCollapsed).toBe(true);
    p.dispose();
  });
});

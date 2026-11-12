// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionsPanel } from "./missionsPanel.ts";
import { uiSettings } from "./uiSettings.ts";

const LINES = [
  { id: "a", title: "Clear the meadow", detail: "Hopbits", progress: "3/8" },
  { id: "b", title: "Find the shrine", detail: "Arcadia", progress: "380 m", state: "tracked" as const },
];

describe("missions panel (#3)", () => {
  let host: HTMLElement;
  let panel: MissionsPanel;
  const rows = () => panel.root.querySelectorAll(".fl-mission").length;
  const header = () => panel.root.querySelector("header button") as HTMLButtonElement;

  beforeEach(() => {
    localStorage.clear();
    uiSettings.reset();
    host = document.createElement("div");
    document.body.append(host);
    panel = new MissionsPanel(host);
  });
  afterEach(() => {
    panel.dispose();
    host.remove();
    uiSettings.reset();
  });

  it("shows the missions, and hides with none", () => {
    expect(panel.root.hidden).toBe(true);
    panel.set(LINES, "2 open");
    expect(panel.root.hidden).toBe(false);
    expect(rows()).toBe(2);
    panel.set([]);
    expect(panel.root.hidden).toBe(true);
  });

  it("a click on the header collapses it to the header line and back, and the state is saved", () => {
    panel.set(LINES, "2 open");
    header().click();
    expect(panel.root.hidden).toBe(false);
    expect(rows()).toBe(0);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("fl.ui.v1")!).missionsCollapsed).toBe(true);
    // A new panel (a reload) starts collapsed.
    const again = new MissionsPanel(host);
    again.set(LINES, "2 open");
    expect(again.root.querySelectorAll(".fl-mission").length).toBe(0);
    again.dispose();
    header().click();
    expect(rows()).toBe(2);
    expect(header().getAttribute("aria-expanded")).toBe("true");
  });

  it("the header is a real button that keeps the keyboard focus when it folds the panel", () => {
    panel.set(LINES, "2 open");
    header().focus();
    header().click();
    expect(header().tagName).toBe("BUTTON");
    expect(document.activeElement).toBe(header());
  });

  it('"Show missions" off in Settings hides it at once, and on brings it back', () => {
    panel.set(LINES, "2 open");
    uiSettings.set({ missions: false });
    expect(panel.root.hidden).toBe(true);
    panel.set([LINES[0]!], "1 open"); // updates keep coming while hidden
    expect(panel.root.hidden).toBe(true);
    uiSettings.set({ missions: true });
    expect(panel.root.hidden).toBe(false);
    expect(rows()).toBe(1);
  });

  it("a +N more line opens the journal (D-polish-ux-1)", () => {
    let opened = 0;
    panel.set(LINES, "2 open", { count: 2, open: () => opened++ });
    const more = panel.root.querySelector<HTMLButtonElement>(".fl-missions__more")!;
    expect(more.textContent).toContain("+2 more");
    more.click();
    expect(opened).toBe(1);
    panel.set(LINES, "2 open");
    expect(panel.root.querySelector(".fl-missions__more")).toBeNull();
  });
});

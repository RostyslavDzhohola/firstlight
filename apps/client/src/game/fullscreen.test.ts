// Fullscreen + Keyboard Lock (D-controls-3): Esc is held for the game only while in fullscreen, and
// is given back however fullscreen ends (holding Esc, the browser's controls, the menu button).

import { afterEach, describe, expect, it, vi } from "vitest";

function page() {
  const doc = Object.assign(new EventTarget(), {
    fullscreenElement: null as object | null,
    fullscreenEnabled: true,
    documentElement: {} as { requestFullscreen?: () => Promise<void> },
    exitFullscreen: async () => {
      doc.fullscreenElement = null;
      doc.dispatchEvent(new Event("fullscreenchange"));
    },
  });
  doc.documentElement.requestFullscreen = async () => {
    doc.fullscreenElement = doc.documentElement;
    doc.dispatchEvent(new Event("fullscreenchange"));
  };
  const calls: string[] = [];
  const keyboard = { lock: async (keys?: string[]) => void calls.push(`lock:${keys?.join(",")}`), unlock: () => void calls.push("unlock") };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { keyboard });
  return { doc, calls };
}

describe("fullscreen with Keyboard Lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("locks Esc on entering and unlocks it when fullscreen ends some other way (holding Esc, browser controls)", async () => {
    const { doc, calls } = page();
    const fs = await import("./fullscreen.ts");
    await fs.enterFullscreen();
    expect(fs.isFullscreen()).toBe(true);
    expect(calls).toEqual(["lock:Escape"]);
    doc.fullscreenElement = null; // the browser left fullscreen on its own
    doc.dispatchEvent(new Event("fullscreenchange"));
    expect(calls).toEqual(["lock:Escape", "unlock"]);
  });

  it("the menu button's way out unlocks once; entering again locks again", async () => {
    const { calls } = page();
    const fs = await import("./fullscreen.ts");
    await fs.enterFullscreen();
    await fs.toggleFullscreen();
    expect(fs.isFullscreen()).toBe(false);
    expect(calls).toEqual(["lock:Escape", "unlock"]);
    await fs.toggleFullscreen();
    await fs.enterFullscreen(); // already in: no second listener, no extra unlock later
    expect(calls).toEqual(["lock:Escape", "unlock", "lock:Escape", "lock:Escape"]);
  });

  it("a refused fullscreen request locks nothing", async () => {
    const { doc, calls } = page();
    doc.documentElement.requestFullscreen = () => Promise.reject(new Error("no gesture"));
    const fs = await import("./fullscreen.ts");
    await fs.enterFullscreen();
    expect(fs.isFullscreen()).toBe(false);
    expect(calls).toEqual([]);
  });
});

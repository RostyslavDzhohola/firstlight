// @vitest-environment happy-dom
// Open guest prompts follow other tabs (Codex review round 2, should-fix 3): with the Esc menu's Save
// row or the death screen's save line already up, another tab saving makes them ask the session again
// and drop the prompt. (The home page: home/home.stale.test.ts.)

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AuthT from "../net/auth.ts";
import { setupMenuDom, type MenuDom } from "./menu.testutil.ts";

type Listener = Parameters<typeof AuthT.onAccountChange>[0];
const listeners = new Set<Listener>();

vi.mock("../net/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof AuthT>();
  return {
    ...real,
    saveStatus: vi.fn(async () => "guest"),
    onAccountChange: vi.fn((fn: Listener) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  };
});

let r: MenuDom;
let auth: typeof AuthT;
beforeAll(async () => {
  r = await setupMenuDom();
  auth = await import("../net/auth.ts");
}, 60_000);
afterAll(() => vi.useRealTimers());

/** Let the mocked promises and their thens run (timers are faked by the menu rig). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const otherTabSaved = async () => {
  vi.mocked(auth.saveStatus).mockResolvedValue("saved");
  for (const fn of [...listeners]) fn(null, { elsewhere: true });
  await flush();
};

describe("open guest prompts after another tab saves", () => {
  it("the Esc menu's Save progress row goes away", async () => {
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    const game = r.makeGame();
    (game.hud as { you: unknown }).you = { level: 3 };
    new r.Menu(game as never);
    r.setGrant(true);
    game.input.lock();
    await r.settle();
    vi.advanceTimersByTime(2000); // playing for a while (as menu.test.ts), then the browser's Esc
    r.setLock(null);
    vi.advanceTimersByTime(200);
    await flush();
    expect(r.shown.menu()).toBe(true);
    expect(document.querySelector("[data-e2e=menu-save]")).toBeTruthy();
    await otherTabSaved();
    expect(r.shown.menu()).toBe(true);
    expect(document.querySelector("[data-e2e=menu-save]")).toBeNull();
  });

  it("the death screen's save line becomes 'Saved.'", async () => {
    vi.mocked(auth.saveStatus).mockResolvedValue("guest");
    const { showDeath, closeDeath } = await import("./death.ts");
    void showDeath(
      { killerName: "the fall", aliveMs: 1000, level: 3, killer: null, victim: "me", save: Promise.resolve(async () => "dismissed" as const) },
      { name: "Wren_07", starter: 1, lastAlive: null, pick: async () => null },
    );
    await flush();
    expect(document.querySelector("[data-e2e=death-save]")).toBeTruthy();
    await otherTabSaved();
    expect(document.querySelector("[data-e2e=death-save]")).toBeNull();
    expect(document.querySelector(".fl-death__save")?.textContent).toContain("Saved.");
    closeDeath();
  });
});

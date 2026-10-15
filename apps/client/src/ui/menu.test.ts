// @vitest-environment happy-dom
// The real Menu (and its Settings screen) over a DOM, with the real Input: Esc from Settings goes back
// into the game in one press wherever the focus is, the Menu button still goes back to the pause menu,
// and a respawn the server confirms after the death screen closed brings the hint back (D-controls-3).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Menu as MenuT } from "./menu.ts";
import { setupMenuDom, type MenuDom } from "./menu.testutil.ts";

let r: MenuDom;
beforeAll(async () => {
  r = await setupMenuDom();
}, 60_000); // importing the menu pulls in three: slow when the machine is busy
afterAll(() => vi.useRealTimers());

describe("the real Menu", () => {
  let menu: MenuT;
  let game: ReturnType<MenuDom["makeGame"]>;

  beforeAll(() => {
    game = r.makeGame();
    menu = new r.Menu(game as never);
  });
  beforeEach(async () => {
    r.setGrant(false);
    r.lockRequests.length = 0;
    // Start each case on the pause menu: playing for a while, then the browser's Esc.
    if (!r.locked()) {
      r.setGrant(true);
      game.input.lock();
      await r.settle();
      r.setGrant(false);
    }
    vi.advanceTimersByTime(2000);
    r.setLock(null);
    vi.advanceTimersByTime(200);
    r.lockRequests.length = 0;
  });

  const openSettings = () => {
    expect(r.shown.menu()).toBe(true);
    const b = [...document.querySelectorAll(".fl-menu__item")].find((x) => x.textContent?.includes("Settings")) as HTMLButtonElement;
    b.click();
    expect(r.shown.settings()).toBe(true);
  };

  it("Esc with the focus on a setting goes back into the game in one press (hint, lock asked)", async () => {
    openSettings();
    const fov = document.getElementById("fl-fov")!;
    fov.focus();
    r.esc(fov);
    await r.settle();
    expect(r.shown.settings()).toBe(false);
    expect(r.shown.menu()).toBe(false);
    expect(r.shown.hint()).toBe(true);
    expect(r.lockRequests).toEqual(["lock"]);
  });

  it("Esc with the focus outside the settings screen does the same", async () => {
    openSettings();
    (document.activeElement as HTMLElement | null)?.blur();
    r.esc(document.body);
    await r.settle();
    expect(r.shown.settings()).toBe(false);
    expect(r.shown.menu()).toBe(false);
    expect(r.shown.hint()).toBe(true);
    expect(r.lockRequests).toEqual(["lock"]);
  });

  it("the Settings screen's Menu button still goes back to the pause menu", () => {
    openSettings();
    const back = [...document.querySelectorAll(".fl-settings button")].find((x) => x.textContent?.trim() === "Menu") as HTMLButtonElement;
    back.click();
    expect(r.shown.settings()).toBe(false);
    expect(r.shown.menu()).toBe(true);
    expect(r.lockRequests).toEqual([]);
  });

  it("Esc on the menu goes back into the game; when the browser grants the lock, the hint goes too", async () => {
    r.setGrant(true);
    r.esc(document.body);
    await r.settle();
    expect(r.shown.menu()).toBe(false);
    expect(r.shown.hint()).toBe(false);
    expect(r.locked()).not.toBeNull();
  });

  it("a respawn confirmed after the death screen closed brings the hint back (no stuck screen)", async () => {
    // Died while playing: the death screen frees the pointer and owns the screen.
    r.setGrant(true);
    game.input.lock();
    await r.settle();
    r.setGrant(false);
    game.combat.deadUntilRespawn = true;
    r.dom.overlayOpened("death");
    r.setLock(null);
    vi.advanceTimersByTime(1000);
    expect(r.shown.menu()).toBe(false);
    // The character pick closes before the server confirms the respawn: still dead, nothing shows.
    r.dom.overlayClosed("death");
    vi.advanceTimersByTime(1000);
    expect(r.shown.menu()).toBe(false);
    expect(r.shown.hint()).toBe(false);
    // The server's `you` says we're alive again (CombatClient clears the flag and tells the menu).
    game.combat.deadUntilRespawn = false;
    menu.blockersChanged();
    expect(r.shown.hint()).toBe(true);
    expect(r.shown.menu()).toBe(false);
  });
});

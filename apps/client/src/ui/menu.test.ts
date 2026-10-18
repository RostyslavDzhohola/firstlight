// @vitest-environment happy-dom
// The real Menu (and its Settings screen) over a DOM, with the real Input: Esc from Settings goes back
// into the game in one press wherever the focus is, the Menu button still goes back to the pause menu,
// and a respawn the server confirms after the death screen closed brings the hint back (D-controls-3).
// The HUD is hidden under the pause menu (D-ui-1), checked through the real stylesheet.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Menu as MenuT } from "./menu.ts";
import { setupMenuDom, type MenuDom } from "./menu.testutil.ts";
import { withStylesheet } from "./stylesheet.testutil.ts";

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

  it("the HUD hides while the pause menu or its Settings is open and comes back with the game (D-ui-1)", async () => {
    // Every HUD root carries .fl-hud or data-hud (the HUD itself, the tutorial panel, nameplates…).
    const hud = document.createElement("div");
    hud.className = "fl-hud";
    const card = document.createElement("section");
    hud.append(card);
    const tutorial = document.createElement("div");
    tutorial.dataset.hud = "";
    document.body.append(hud, tutorial);
    const seen = () => [card, tutorial].map((e) => getComputedStyle(e).visibility !== "hidden");
    await withStylesheet("ui/menu.css", async () => {
      expect(r.shown.menu()).toBe(true);
      expect(seen(), "under the pause menu").toEqual([false, false]);
      openSettings();
      expect(seen(), "under Settings").toEqual([false, false]);
      r.esc(document.body); // back to the game with the "Click to look around" hint
      await r.settle();
      expect(r.shown.hint()).toBe(true);
      expect(seen(), "back in the game, pointer free").toEqual([true, true]);
      r.esc(document.body); // the menu again, then Esc with the lock granted: playing
      await r.settle();
      expect(r.shown.menu()).toBe(true);
      expect(seen()).toEqual([false, false]);
      r.setGrant(true);
      r.esc(document.body);
      await r.settle();
      expect(r.locked()).not.toBeNull();
      expect(seen(), "playing").toEqual([true, true]);
    }).finally(() => {
      hud.remove();
      tutorial.remove();
    });
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

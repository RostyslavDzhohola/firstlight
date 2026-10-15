// @vitest-environment happy-dom
// Keys in the "Click to look around" state (a refused or lost lock, Esc → Esc): panel and world keys
// work there through the real Menu and Input (Input.inPlay); nothing opens behind the pause menu.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupMenuDom, type MenuDom } from "./menu.testutil.ts";

let r: MenuDom;
beforeAll(async () => {
  r = await setupMenuDom();
}, 60_000); // importing the menu pulls in three: slow when the machine is busy
afterAll(() => vi.useRealTimers());

describe("keys in the 'Click to look around' state (lock refused or lost)", () => {
  it("the Menu marks the hint state in play: panel and world keys work there, not on the menu or under a panel", async () => {
    const game = r.makeGame();
    new r.Menu(game as never);
    const { InventoryClient } = await import("../game/InventoryClient.ts");
    const inv = new InventoryClient({ ...game, net: { room: {}, serverOffset: 0 } } as never);
    const pressI = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", code: "KeyI", bubbles: true, cancelable: true }));
    r.setGrant(false);
    vi.advanceTimersByTime(2000);
    // The hand-over's lock is refused (no gesture): the game with the hint.
    game.input.lock();
    await r.settle();
    expect(r.shown.hint()).toBe(true);
    expect(game.input.locked).toBe(false);
    expect(game.input.inPlay).toBe(true);
    // I opens the inventory without the lock (it frees the mouse anyway); the hint state ends under it.
    pressI();
    expect(inv.panel.isOpen).toBe(true);
    expect(game.input.inPlay).toBe(false);
    pressI(); // I again closes it; the re-lock is refused: back to the hint, keys live again
    await r.settle();
    expect(inv.panel.isOpen).toBe(false);
    expect(r.shown.hint()).toBe(true);
    expect(game.input.inPlay).toBe(true);
    // On the pause menu nothing opens behind it.
    r.esc(document.body);
    expect(r.shown.menu()).toBe(true);
    expect(game.input.inPlay).toBe(false);
    pressI();
    expect(inv.panel.isOpen).toBe(false);
    inv.dispose();
  });
});

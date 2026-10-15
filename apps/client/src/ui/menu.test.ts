// @vitest-environment happy-dom
// The real Menu (and its Settings screen) over a DOM, with the real Input: Esc from Settings goes back
// into the game in one press wherever the focus is, the Menu button still goes back to the pause menu,
// and a respawn the server confirms after the death screen closed brings the hint back (D-controls-3).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Input as InputT } from "../game/input.ts";
import type { Menu as MenuT } from "./menu.ts";

let Menu: typeof MenuT;
let Input: typeof InputT;
let dom: typeof import("./dom.ts");
let locked: Element | null = null;
const lockRequests: string[] = [];
let grant = false;

function setLock(el: Element | null) {
  locked = el;
  document.dispatchEvent(new Event("pointerlockchange"));
}

beforeAll(async () => {
  history.replaceState(null, "", "/?devguest"); // no account lookups from the menu
  Object.defineProperty(document, "pointerLockElement", { get: () => locked, configurable: true });
  (document as unknown as { exitPointerLock: () => void }).exitPointerLock = () => setLock(null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  ({ Menu } = await import("./menu.ts"));
  ({ Input } = await import("../game/input.ts"));
  dom = await import("./dom.ts");
});
afterAll(() => vi.useRealTimers());

function makeGame() {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = () => {
    lockRequests.push("lock");
    if (!grant) return Promise.reject(Object.assign(new Error("refused"), { name: "NotAllowedError" }));
    setLock(canvas);
    return Promise.resolve();
  };
  const input = new Input(canvas);
  const ctx = {
    settings: { tier: "medium", auto: true, webgpu: false, renderScale: 1, on: {} as Record<string, boolean> },
    stored: () => ({ features: {} }),
    webgpu: false,
    onChange: () => () => {},
    setAutoTier() {},
    setTier() {},
    setFeature() {},
    setRenderScale() {},
  };
  const game = {
    input,
    ctx,
    combat: { deadUntilRespawn: false },
    net: { room: null, serverOffset: 0 },
    hud: { you: null },
    bodyId: "portus",
    applyGraphics: async (f: () => void) => f(),
    audio: { volumes: { master: 0.8, music: 0.35, sfx: 0.8, voice: 1 }, applyVolumes() {} },
  };
  return { game, canvas };
}

const shown = {
  menu: () => !!document.querySelector('[data-e2e="pause-menu"]') && !(document.querySelector(".fl-menu") as HTMLElement).hidden,
  settings: () => !!document.querySelector(".fl-settings"),
  hint: () => document.querySelector('[data-e2e="click-to-look"]')!.classList.contains("is-on"),
};
const settle = async () => {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};
const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));

describe("the real Menu", () => {
  let menu: MenuT;
  let game: ReturnType<typeof makeGame>["game"];

  beforeAll(() => {
    ({ game } = makeGame());
    menu = new Menu(game as never);
  });
  beforeEach(async () => {
    grant = false;
    lockRequests.length = 0;
    // Start each case on the pause menu: playing for a while, then the browser's Esc.
    if (!locked) {
      grant = true;
      game.input.lock();
      await settle();
      grant = false;
    }
    vi.advanceTimersByTime(2000);
    setLock(null);
    vi.advanceTimersByTime(200);
    lockRequests.length = 0;
  });

  const openSettings = () => {
    expect(shown.menu()).toBe(true);
    const b = [...document.querySelectorAll(".fl-menu__item")].find((x) => x.textContent?.includes("Settings")) as HTMLButtonElement;
    b.click();
    expect(shown.settings()).toBe(true);
  };

  it("Esc with the focus on a setting goes back into the game in one press (hint, lock asked)", async () => {
    openSettings();
    const fov = document.getElementById("fl-fov")!;
    fov.focus();
    esc(fov);
    await settle();
    expect(shown.settings()).toBe(false);
    expect(shown.menu()).toBe(false);
    expect(shown.hint()).toBe(true);
    expect(lockRequests).toEqual(["lock"]);
  });

  it("Esc with the focus outside the settings screen does the same", async () => {
    openSettings();
    (document.activeElement as HTMLElement | null)?.blur();
    esc(document.body);
    await settle();
    expect(shown.settings()).toBe(false);
    expect(shown.menu()).toBe(false);
    expect(shown.hint()).toBe(true);
    expect(lockRequests).toEqual(["lock"]);
  });

  it("the Settings screen's Menu button still goes back to the pause menu", () => {
    openSettings();
    const back = [...document.querySelectorAll(".fl-settings button")].find((x) => x.textContent?.trim() === "Menu") as HTMLButtonElement;
    back.click();
    expect(shown.settings()).toBe(false);
    expect(shown.menu()).toBe(true);
    expect(lockRequests).toEqual([]);
  });

  it("Esc on the menu goes back into the game; when the browser grants the lock, the hint goes too", async () => {
    grant = true;
    esc(document.body);
    await settle();
    expect(shown.menu()).toBe(false);
    expect(shown.hint()).toBe(false);
    expect(locked).not.toBeNull();
  });

  it("a respawn confirmed after the death screen closed brings the hint back (no stuck screen)", async () => {
    // Died while playing: the death screen frees the pointer and owns the screen.
    grant = true;
    game.input.lock();
    await settle();
    grant = false;
    game.combat.deadUntilRespawn = true;
    dom.overlayOpened("death");
    setLock(null);
    vi.advanceTimersByTime(1000);
    expect(shown.menu()).toBe(false);
    // The character pick closes before the server confirms the respawn: still dead, nothing shows.
    dom.overlayClosed("death");
    vi.advanceTimersByTime(1000);
    expect(shown.menu()).toBe(false);
    expect(shown.hint()).toBe(false);
    // The server's `you` says we're alive again (CombatClient clears the flag and tells the menu).
    game.combat.deadUntilRespawn = false;
    menu.blockersChanged();
    expect(shown.hint()).toBe(true);
    expect(shown.menu()).toBe(false);
  });
});

// Shared rig for tests that drive the real Menu over happy-dom (menu.test.ts, menuKeys.test.ts): a
// pointer lock the test grants or refuses, the real Input on a canvas, and a stand-in Game with just
// what the Menu and its Settings screen read. Call setupMenuDom() in beforeAll (one Menu per file:
// each Menu listens on the document, so two would both answer the same Esc).

import { vi } from "vitest";
import type { Input as InputT } from "../game/input.ts";
import type { Menu as MenuT } from "./menu.ts";

export interface MenuDom {
  Menu: typeof MenuT;
  Input: typeof InputT;
  dom: typeof import("./dom.ts");
  /** Lock requests the canvas received. */
  lockRequests: string[];
  /** The next lock requests are granted (true) or refused like Chrome without a gesture (false). */
  setGrant(on: boolean): void;
  setLock(el: Element | null): void;
  locked(): Element | null;
  makeGame(): ReturnType<typeof gameFor>;
  shown: { menu(): boolean; settings(): boolean; hint(): boolean };
  settle(): Promise<void>;
  esc(target: EventTarget): boolean;
  key(code: string, key: string, target?: EventTarget): boolean;
}

function gameFor(input: InputT) {
  const ctx = {
    settings: { tier: "medium", auto: true, webgpu: false, renderScale: 1, on: {} as Record<string, boolean>, extras: [] },
    stored: () => ({ features: {} }),
    webgpu: false,
    onChange: () => () => {},
    setAutoTier() {},
    setTier() {},
    setFeature() {},
    setRenderScale() {},
  };
  return {
    input,
    ctx,
    combat: { deadUntilRespawn: false },
    net: { room: null as unknown, serverOffset: 0 },
    hud: { you: null },
    photo: null,
    bodyId: "portus",
    applyGraphics: async (f: () => void) => f(),
    audio: { volumes: { master: 0.8, music: 0.35, sfx: 0.8, voice: 1 }, applyVolumes() {} },
  };
}

export async function setupMenuDom(): Promise<MenuDom> {
  let locked: Element | null = null;
  let grant = false;
  const lockRequests: string[] = [];
  const setLock = (el: Element | null) => {
    locked = el;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  history.replaceState(null, "", "/?devguest"); // no account lookups from the menu
  Object.defineProperty(document, "pointerLockElement", { get: () => locked, configurable: true });
  (document as unknown as { exitPointerLock: () => void }).exitPointerLock = () => setLock(null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  const { Menu } = await import("./menu.ts");
  const { Input } = await import("../game/input.ts");
  const dom = await import("./dom.ts");
  const makeGame = () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = () => {
      lockRequests.push("lock");
      if (!grant) return Promise.reject(Object.assign(new Error("refused"), { name: "NotAllowedError" }));
      setLock(canvas);
      return Promise.resolve();
    };
    return gameFor(new Input(canvas));
  };
  const key = (code: string, k: string, target: EventTarget = document.body) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  return {
    Menu,
    Input,
    dom,
    lockRequests,
    setGrant: (on) => (grant = on),
    setLock,
    locked: () => locked,
    makeGame,
    shown: {
      menu: () => !!document.querySelector('[data-e2e="pause-menu"]') && !(document.querySelector(".fl-menu") as HTMLElement).hidden,
      settings: () => !!document.querySelector(".fl-settings"),
      hint: () => document.querySelector('[data-e2e="click-to-look"]')!.classList.contains("is-on"),
    },
    settle: async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
    esc: (target) => key("Escape", "Escape", target),
    key,
  };
}

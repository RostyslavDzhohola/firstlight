import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "./input.ts";
import { HOTKEYS } from "./keys.ts";

const listeners = { addEventListener() {} };

/** A canvas stand-in. Calls are recorded by hand: a vi.fn spy would itself observe the returned
 *  promise and so hide an unhandled rejection. */
function element(request: (opts?: unknown) => Promise<void> | void) {
  const calls: unknown[][] = [];
  const el = { ...listeners, requestPointerLock: (...args: unknown[]) => (calls.push(args), request(args[0])) };
  return { el: el as unknown as HTMLElement, calls };
}

function refused(name: string) {
  return Promise.reject(Object.assign(new Error(name), { name }));
}

/** Resolves after pending promise reactions (and an unhandled-rejection check) have run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Input.lock", () => {
  vi.stubGlobal("window", listeners);
  vi.stubGlobal("document", listeners);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  afterEach(() => {
    unhandled.length = 0;
  });
  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals();
  });

  it("asks for raw mouse movement", async () => {
    const { el, calls } = element(() => Promise.resolve());
    new Input(el).lock();
    await settle();
    expect(calls).toEqual([[{ unadjustedMovement: true }]]);
  });

  it("a refused request (no user gesture, re-lock too soon after Esc) leaves the pointer free without an uncaught rejection", async () => {
    const { el, calls } = element(() => refused("NotAllowedError"));
    new Input(el).lock();
    await settle();
    expect(calls).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("falls back to ordinary pointer lock where raw movement isn't supported", async () => {
    const { el, calls } = element((opts) => opts ? refused("NotSupportedError") : Promise.resolve());
    new Input(el).lock();
    await settle();
    expect(calls).toEqual([[{ unadjustedMovement: true }], []]);
    expect(unhandled).toEqual([]);
  });

  it("works with browsers whose requestPointerLock returns nothing", async () => {
    const { el } = element(() => undefined);
    expect(() => new Input(el).lock()).not.toThrow();
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe("Input.hit (hotkeys, D-controls-2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads Shift as it was at the key press, so a quick Shift+P between two slow frames still counts", () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", new EventTarget());
    const input = new Input(Object.assign(new EventTarget(), { requestPointerLock: () => Promise.resolve() }) as unknown as HTMLElement);
    const key = (type: string, code: string, shiftKey: boolean) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, shiftKey }));
    key("keydown", "ShiftLeft", true);
    key("keydown", "KeyP", true);
    key("keyup", "KeyP", true);
    key("keyup", "ShiftLeft", false); // all before the next frame
    expect(input.hit(HOTKEYS.photo)).toBe(true);
    expect(input.hit(HOTKEYS.screenshot)).toBe(false);
    input.endFrame();
    key("keydown", "KeyP", false);
    expect(input.hit(HOTKEYS.photo)).toBe(false);
    expect(input.hit(HOTKEYS.screenshot)).toBe(true);
    key("keydown", "Backquote", false);
    expect(input.hit(HOTKEYS.perf)).toBe(true);
    expect(input.hit(HOTKEYS.adminConsole)).toBe(false);
  });
});

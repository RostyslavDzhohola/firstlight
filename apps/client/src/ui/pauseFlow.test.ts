// The Esc menu's state machine (D-controls-3), alone and wired to the real Input the way menu.ts wires
// it, against the sequences seen in the owner's recording (the menu blinking back after a click) and
// Chrome's pointer-lock rules (Esc is no gesture; a re-lock right after Esc is refused).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Input } from "../game/input.ts";
import { ResolutionLadder } from "../render/timing.ts";
import { bindPointerLock, coversWorld, PAUSE_TIMING, PauseFlow, pauseKey, type PauseClock, type PauseHost, type PauseState } from "./pauseFlow.ts";

/** A hand-driven clock: `advance(ms)` runs the timers that come due. */
function manualClock() {
  let t = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: PauseClock = {
    now: () => t,
    setTimeout: (fn, ms) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (x.at > t) continue;
      timers.delete(id);
      x.fn();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function rig() {
  const { clock, advance, pending } = manualClock();
  const drawn: PauseState[] = [];
  const calls: string[] = [];
  let overlays = 0;
  const host: PauseHost = {
    render: (s) => drawn.push(s),
    requestLock: () => calls.push("lock"),
    exitLock: () => calls.push("exit"),
    overlayOpen: () => overlays > 0,
  };
  const flow = new PauseFlow(host, clock);
  return { flow, drawn, calls, advance, pending, setOverlays: (n: number) => (overlays = n) };
}

/** Played for a while, as after the hand-over. */
function playing() {
  const r = rig();
  r.flow.onLocked();
  r.advance(5000);
  r.drawn.length = 0;
  return r;
}

describe("PauseFlow", () => {
  it("Esc in play (the browser frees the pointer) opens the menu once the unlock has lasted", () => {
    const r = playing();
    r.flow.onUnlocked();
    expect(r.flow.state).toBe("pending");
    r.advance(PAUSE_TIMING.menuDelayMs - 1);
    expect(r.drawn).toEqual(["pending"]);
    r.advance(1);
    expect(r.flow.state).toBe("menu");
    expect(r.drawn).toEqual(["pending", "menu"]);
  });

  it("an unlock that is over within the delay shows nothing (no menu flash)", () => {
    const r = playing();
    r.flow.onUnlocked();
    r.advance(40);
    r.flow.onLocked();
    r.advance(1000);
    expect(r.drawn).not.toContain("menu");
    expect(r.flow.state).toBe("playing");
    expect(r.pending()).toBe(0);
  });

  it("the owner's blink: a click on the menu locks, the browser drops the lock 50 ms later: back in the game with the hint, never the menu again", () => {
    const r = playing();
    r.flow.onUnlocked();
    r.advance(1000);
    expect(r.flow.state).toBe("menu");
    r.drawn.length = 0;
    r.flow.resume(); // click on the backdrop or Resume
    expect(r.calls).toEqual(["lock"]);
    r.flow.onLocked();
    r.advance(50);
    r.flow.onUnlocked();
    r.advance(2000);
    expect(r.drawn).toEqual(["free", "playing", "free"]);
    expect(r.flow.state).toBe("free");
    // The next click (on the world, through Input) locks for good.
    r.flow.onLocked();
    expect(r.flow.state).toBe("playing");
  });

  it("a refused lock (Chrome's re-lock block, no gesture) leaves the game with the hint; it never toggles the menu", () => {
    const r = playing();
    r.flow.onUnlocked();
    r.advance(1000);
    r.flow.resume();
    r.flow.onLockError();
    expect(r.flow.state).toBe("free");
    const menu = rig();
    menu.flow.onUnlocked();
    menu.advance(1000);
    menu.flow.onLockError(); // some other request failed while the menu is up: it stays
    expect(menu.flow.state).toBe("menu");
  });

  it("Esc on the menu goes back into the game and asks for the pointer; Esc again reopens the menu", () => {
    const r = playing();
    r.flow.onUnlocked();
    r.advance(1000);
    expect(r.flow.onEscape()).toBe(true);
    expect(r.flow.state).toBe("free");
    expect(r.calls).toEqual(["lock"]); // works where the page freed the pointer itself, else refused
    r.flow.onLockError();
    expect(r.flow.state).toBe("free");
    expect(r.flow.onEscape()).toBe(true);
    expect(r.flow.state).toBe("menu");
  });

  it("under Keyboard Lock Esc reaches the page while locked: we free the pointer and the menu opens at once", () => {
    const r = playing();
    expect(r.flow.onEscape()).toBe(true);
    expect(r.calls).toEqual(["exit"]);
    r.flow.onUnlocked();
    expect(r.flow.state).toBe("menu"); // no delay: we asked for it
    expect(r.flow.onEscape()).toBe(true); // and Esc again resumes (a page-initiated unlock may re-lock without a gesture)
    expect(r.calls).toEqual(["exit", "lock"]);
    r.flow.onLocked();
    expect(r.flow.state).toBe("playing");
  });

  it("Esc that arrives while the unlock is pending opens the menu at once (browsers that deliver the unlocking Esc)", () => {
    const r = playing();
    r.flow.onUnlocked();
    expect(r.flow.onEscape()).toBe(true);
    expect(r.flow.state).toBe("menu");
    r.advance(1000);
    expect(r.drawn).toEqual(["pending", "menu"]);
  });

  it("Enter or Space resume from the menu only", () => {
    const r = playing();
    expect(r.flow.onConfirm()).toBe(false);
    r.flow.onUnlocked();
    r.advance(1000);
    expect(r.flow.onConfirm()).toBe(true);
    expect(r.flow.state).toBe("free");
    expect(r.calls).toEqual(["lock"]);
  });

  it("panels own the screen and their Esc; closing one goes back to the game, not the menu", () => {
    const r = playing();
    r.setOverlays(1); // the map opens (registered before it frees the pointer)
    r.flow.onOverlayChange();
    expect(r.flow.state).toBe("playing");
    r.flow.onUnlocked();
    expect(r.flow.state).toBe("away");
    expect(r.flow.onEscape()).toBe(false); // the map closes itself
    r.setOverlays(0);
    r.flow.onOverlayChange();
    expect(r.flow.state).toBe("free");
    r.advance(1000);
    expect(r.drawn).not.toContain("menu");
  });

  it("a card opened from the menu (save, sign-in) leaves the menu under it", () => {
    const r = playing();
    r.flow.onUnlocked();
    r.advance(1000);
    r.setOverlays(1);
    r.flow.onOverlayChange();
    expect(r.flow.state).toBe("menu");
    r.setOverlays(0);
    r.flow.onOverlayChange();
    expect(r.flow.state).toBe("menu");
  });

  it("a notice (logged out, connection lost) suppresses everything until it lets go", () => {
    const r = playing();
    r.flow.suppress(true);
    r.flow.onUnlocked();
    r.advance(1000);
    expect(r.flow.state).toBe("away");
    expect(r.flow.onEscape()).toBe(false);
    r.flow.resume();
    expect(r.calls).toEqual([]);
    r.flow.suppress(false);
    expect(r.flow.state).toBe("free");
  });

  it("a first lock refused at the hand-over shows the hint", () => {
    const r = rig();
    expect(r.flow.state).toBe("away");
    r.flow.onLockError();
    expect(r.flow.state).toBe("free");
  });
});

// ------------------------------------------------------------------------------------------------ the resolution ladder

describe("PauseFlow and the resolution ladder (D-view-4)", () => {
  it("the pause menu and full-screen overlays cover the world; play, the free pointer and the menu's delay don't", () => {
    const all: PauseState[] = ["playing", "pending", "menu", "free", "away"];
    expect(all.filter(coversWorld)).toEqual(["menu", "away"]);
  });

  /**
   * The flow drawing its states with the ladder suspended while they cover the world (Game wires
   * menu.onState the same way), and the game's frames fed to the ladder at `frameMs` on the flow's clock.
   */
  function withLadder(frameMs: number, wired = true) {
    const { clock, advance } = manualClock();
    const ladder = new ResolutionLadder();
    let overlays = 0;
    const flow = new PauseFlow(
      {
        render: (s) => wired && ladder.setSuspended(coversWorld(s)),
        requestLock: () => {},
        exitLock: () => {},
        overlayOpen: () => overlays > 0,
      },
      clock,
    );
    const play = (ms: number) => {
      for (let left = ms; left > 0; left -= frameMs) {
        advance(frameMs);
        ladder.sample(clock.now(), frameMs, null, 12);
      }
    };
    return { flow, ladder, play, setOverlays: (n: number) => (overlays = n) };
  }

  it("opening and closing the menu 10 times over slow frames leaves the ladder at its rung", () => {
    for (const wired of [true, false]) {
      const r = withLadder(40, wired); // 25 fps under the menu and in the short stretches of play
      r.flow.onLocked();
      r.play(1500);
      const start = r.ladder.index;
      for (let i = 0; i < 10; i++) {
        r.flow.onUnlocked(); // Esc: the browser frees the pointer, the menu shows after its delay
        r.play(2500);
        expect(r.flow.state).toBe("menu");
        r.flow.resume();
        r.flow.onLocked();
        r.play(800);
      }
      if (wired) expect(r.ladder.index, "suspended under the menu").toBe(start);
      else expect(r.ladder.index, "the same frames step the ladder down when nothing suspends it").toBeGreaterThan(start);
    }
  });

  it("a panel or the death screen suspends it too, and play after it samples again", () => {
    const r = withLadder(40);
    r.flow.onLocked();
    r.play(1000);
    r.setOverlays(1);
    r.flow.onUnlocked(); // a panel frees the pointer
    expect(r.flow.state).toBe("away");
    expect(r.ladder.suspended).toBe(true);
    r.play(20_000);
    expect(r.ladder.index).toBe(0);
    r.setOverlays(0);
    r.flow.onOverlayChange();
    expect(r.ladder.suspended).toBe(false);
    r.play(10_000); // slow play outside the overlay still steps down
    expect(r.ladder.index).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------ with the real Input

/** document/window stand-ins that dispatch real Events (Node has EventTarget). */
class FakeDoc extends EventTarget {
  pointerLockElement: Element | null = null;
  exitPointerLock = () => this.setLock(null);
  setLock(el: Element | null) {
    this.pointerLockElement = el;
    this.dispatchEvent(new Event("pointerlockchange"));
  }
}

function key(type: "keydown" | "keyup", code: string, opts: { key?: string; repeat?: boolean } = {}) {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(e, { code, key: opts.key ?? code, repeat: !!opts.repeat, shiftKey: false });
  return e as Event & { code: string; key: string; repeat: boolean };
}

describe("PauseFlow wired to the real Input (as menu.ts wires it)", () => {
  let doc: FakeDoc;
  let win: EventTarget;
  let canvas: EventTarget & { requestPointerLock: (o?: unknown) => Promise<void> };
  /** How the next lock request ends: granted, refused (Chrome's ~1 s block after Esc), or granted then dropped. */
  let browser: "grant" | "refuse" | "grant-then-drop";
  let requests: unknown[];
  let input: Input;
  let flow: PauseFlow;
  let advance: (ms: number) => void;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    doc = new FakeDoc();
    win = new EventTarget();
    requests = [];
    browser = "grant";
    canvas = Object.assign(new EventTarget(), {
      requestPointerLock: (o?: unknown) => {
        requests.push(o);
        if (browser === "refuse") return Promise.reject(Object.assign(new Error("refused"), { name: "NotAllowedError" }));
        doc.setLock(canvas as unknown as Element);
        if (browser === "grant-then-drop") setTimeout(() => doc.setLock(null), 0);
        return Promise.resolve();
      },
    });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    input = new Input(canvas as unknown as HTMLElement);
    const m = manualClock();
    advance = m.advance;
    flow = new PauseFlow({ render: () => {}, requestLock: () => input.lock(), exitLock: () => doc.exitPointerLock(), overlayOpen: () => false }, m.clock);
    bindPointerLock(flow, doc, input);
    doc.addEventListener("keydown", (e) => pauseKey(flow, e as unknown as KeyboardEvent));
  });
  afterEach(() => vi.unstubAllGlobals());

  const click = async () => {
    canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    await settle();
  };
  const press = async (code: string, opts: { key?: string; repeat?: boolean } = {}) => {
    const e = key("keydown", code, opts);
    doc.dispatchEvent(e); // document listeners first, as in the page (bubble: document, then window)
    if (!e.cancelBubble) win.dispatchEvent(key("keydown", code, opts)); // stopPropagation keeps it from the game
    await settle();
    return e;
  };

  it("click → play; Esc (browser unlock) → menu; Esc → game with the hint, re-lock refused; click → play", async () => {
    await click();
    expect(input.locked).toBe(true);
    expect(flow.state).toBe("playing");
    advance(5000);

    doc.setLock(null); // the browser's Esc: the page doesn't see the key
    advance(PAUSE_TIMING.menuDelayMs);
    expect(flow.state).toBe("menu");

    browser = "refuse"; // Esc is no gesture, and it's within a second of the user's Esc
    const esc = await press("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(flow.state).toBe("free");
    expect(input.locked).toBe(false);

    browser = "grant";
    await click(); // "Click to look around"
    expect(input.locked).toBe(true);
    expect(flow.state).toBe("playing");
  });

  it("the blink: a click that gets a lock the browser drops at once lands in the game (hint), and the menu never comes back", async () => {
    await click();
    advance(5000);
    doc.setLock(null);
    advance(1000);
    expect(flow.state).toBe("menu");
    browser = "grant-then-drop";
    flow.resume(); // the menu's backdrop click
    await settle();
    await settle();
    advance(2000);
    expect(flow.state).toBe("free");
    expect(input.locked).toBe(false);
    browser = "grant";
    await click();
    expect(flow.state).toBe("playing");
  });

  it("Enter on the menu resumes (a gesture: the lock is granted) without reaching the game as a key", async () => {
    await click();
    advance(5000);
    doc.setLock(null);
    advance(1000);
    const enter = await press("Space", { key: " " });
    expect(enter.defaultPrevented).toBe(true);
    expect(flow.state).toBe("playing");
    expect(input.keys.has("Space")).toBe(false); // no jump on the way back
  });

  it("holding Esc (key repeat, e.g. to leave fullscreen) doesn't flip the menu back and forth", async () => {
    await click();
    advance(5000);
    doc.setLock(null);
    advance(1000);
    browser = "refuse";
    await press("Escape");
    expect(flow.state).toBe("free");
    for (let i = 0; i < 5; i++) await press("Escape", { repeat: true });
    expect(flow.state).toBe("free");
  });

  it("a double click asks for the pointer once", async () => {
    let resolve!: () => void;
    canvas.requestPointerLock = (o?: unknown) => (requests.push(o), new Promise<void>((r) => (resolve = r)));
    canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    canvas.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    expect(requests).toHaveLength(1);
    resolve();
    await settle();
  });
});

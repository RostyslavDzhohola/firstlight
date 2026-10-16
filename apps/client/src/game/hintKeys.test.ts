// @vitest-environment happy-dom
// Keys in the "Click to look around" state through the real handlers (D-controls-4, review of
// 4dbc3d8): M and J (QuestClient), T (OnboardingClient), E, 1–4 and R (CombatClient), H (HorseClient)
// act there; none of them acts on the pause menu or behind a loading screen; and a charge held when
// the pointer goes is cancelled instead of landing a heavy on release or on the next lock. The hint
// state comes from the real Menu and Input (menu.testutil.ts). Handlers run on their real prototype
// code with stand-in fields, since their constructors build the 3D world.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { setupMenuDom, type MenuDom } from "../ui/menu.testutil.ts";

let r: MenuDom;
let game: ReturnType<MenuDom["makeGame"]> & Record<string, unknown>;
let loading = false;
const sent: [string, unknown][] = [];
const calls: string[] = [];
let mods: {
  QuestClient: typeof import("./QuestClient.ts").QuestClient;
  CombatClient: typeof import("./CombatClient.ts").CombatClient;
  HorseClient: typeof import("./HorseClient.ts").HorseClient;
  OnboardingClient: typeof import("./OnboardingClient.ts").OnboardingClient;
  OnboardingSteps: typeof import("./onboardingSteps.ts").OnboardingSteps;
};

beforeAll(async () => {
  r = await setupMenuDom();
  mods = {
    QuestClient: (await import("./QuestClient.ts")).QuestClient,
    CombatClient: (await import("./CombatClient.ts")).CombatClient,
    HorseClient: (await import("./HorseClient.ts")).HorseClient,
    OnboardingClient: (await import("./OnboardingClient.ts")).OnboardingClient,
    OnboardingSteps: (await import("./onboardingSteps.ts")).OnboardingSteps,
  };
  game = r.makeGame() as typeof game;
  new r.Menu(game as never);
  game.input.suspendedWhile = () => loading; // as Game does: !running || travelling
  const room = { sessionId: "me", state: { players: new Map(), horses: new Map() }, send: (t: string, m: unknown) => void sent.push([t, m]) };
  Object.assign(game, {
    net: { room, serverOffset: 0 },
    hud: { you: { selected: 0, horses: true }, promptShown: false, setPrompt() {}, setHp() {}, setIdentity() {}, setSafe() {}, setLogout() {} },
    player: { pos: new THREE.Vector3(0, 500, 0), vel: new THREE.Vector3(), saddleLocked: false, mounted: false },
    ctx: { ...(game.ctx as object), camera: { fov: 75, updateProjectionMatrix() {} } },
    self: { setLocalFlags() {}, trigger() {} },
  });
}, 60_000);
afterAll(() => vi.useRealTimers());

beforeEach(async () => {
  sent.length = calls.length = 0;
  loading = false;
  game.input.endFrame();
  await toHint();
});

/** The hint state, as after a refused lock: the browser refuses every request. */
async function toHint() {
  r.setGrant(false);
  if (r.locked()) {
    vi.advanceTimersByTime(1000);
    r.setLock(null);
    vi.advanceTimersByTime(200);
  }
  if (r.shown.menu()) r.esc(document.body);
  else game.input.lock();
  await r.settle();
  expect(r.shown.hint()).toBe(true);
}
async function toMenu() {
  if (!r.shown.menu()) r.esc(document.body);
  expect(r.shown.menu()).toBe(true);
}
async function lockFor(ms: number) {
  r.setGrant(true);
  game.input.lock();
  await r.settle();
  vi.advanceTimersByTime(ms);
  expect(game.input.locked).toBe(true);
}

const press = (code: string) => {
  const e = new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};
const release = (code: string) => window.dispatchEvent(new KeyboardEvent("keyup", { code, key: code, bubbles: true }));
const mouse = (type: "mousedown" | "mouseup", button: number) => {
  const canvas = document.querySelector("canvas")!;
  (type === "mousedown" ? canvas : window).dispatchEvent(new MouseEvent(type, { button, bubbles: true }));
};
const types = () => sent.map(([t]) => t);

// ---- the real handlers on stand-in fields ----

function questKey(code: string) {
  const fake = { game, console: { isOpen: false }, map: { open: () => calls.push("map") }, journal: { show: () => calls.push("journal") }, isAdmin: () => false };
  (mods.QuestClient.prototype as unknown as { key(e: KeyboardEvent): void }).key.call(fake, press(code));
  release(code);
}

let combat: InstanceType<typeof mods.CombatClient>;
function combatFrame(now: number) {
  combat.update(1 / 60, now);
  game.input.endFrame();
}

function horseFrame() {
  const fake = Object.assign(Object.create(mods.HorseClient.prototype), { game, mount: { riding: false } });
  (fake as { input(): void }).input();
  game.input.endFrame();
}

function onboardingFrame(toggle: () => void) {
  const fake = Object.assign(Object.create(mods.OnboardingClient.prototype), {
    game: { ...game, photo: null, combat: game.combat },
    dummies: { update() {}, dummies: [], setDown() {}, chest: (_i: number, v: THREE.Vector3) => v.set(0, 0, 0) },
    receivedYou: true,
    onboarding: { hits: [0, 0, 0] },
    active: true,
    ended: false,
    paid: false,
    hud: { toggleChecklist: toggle, render() {}, setCallout() {}, showDone() {} },
    progress: { steps: new mods.OnboardingSteps(), save() {} },
    lastPos: new THREE.Vector3(),
    hasLast: false,
    portals: [],
    phrased: false,
    doneTimer: { running: false, start() {}, stop() {}, tick: () => false },
  });
  (fake as { update(dt: number, now: number): void }).update(1 / 60, performance.now());
  game.input.endFrame();
}

describe("keys in the hint state act through the real handlers", () => {
  beforeAll(() => {
    combat = Object.assign(Object.create(mods.CombatClient.prototype), {
      game,
      effects: { update() {} },
      deniedGate: { press() {} },
      saveNudge: { poll: () => false },
      wheel: { update: () => false },
      updatePickupPrompt() {},
      tryPickup: () => calls.push("pickup"),
      currentWeapon: () => ({ def: WEAPON_BY_ID.get("axe")!, tier: 1 }),
      death: { dead: false },
      tutorialBusy: null,
      training: null,
      lastFire: 0,
      chargeStart: 0,
      wasRmb: false,
      saddleRmb: false,
      blocking: false,
      scoped: false,
      gateRmb: false,
      baseFov: 75,
    });
  });

  it("M and J open the map and the journal (QuestClient)", () => {
    expect(game.input.locked).toBe(false);
    questKey("KeyM");
    questKey("KeyJ");
    expect(calls).toEqual(["map", "journal"]);
  });

  it("E picks up, 1–4 equip and R reloads (CombatClient)", () => {
    press("Digit2");
    press("KeyR");
    press("KeyE");
    combatFrame(1000);
    expect(types()).toEqual(["equip", "reload"]);
    expect(calls).toEqual(["pickup"]);
  });

  it("H whistles a horse (HorseClient)", () => {
    press("KeyH");
    horseFrame();
    expect(sent).toEqual([["horse", { action: "whistle" }]]);
  });

  it("T toggles the tutorial checklist (OnboardingClient)", () => {
    let toggled = 0;
    press("KeyT");
    onboardingFrame(() => toggled++);
    expect(toggled).toBe(1);
  });

  it("none of them acts on the pause menu", async () => {
    await toMenu();
    questKey("KeyM");
    press("Digit2");
    press("KeyE");
    combatFrame(1000);
    press("KeyH");
    horseFrame();
    let toggled = 0;
    press("KeyT");
    onboardingFrame(() => toggled++);
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(toggled).toBe(0);
  });

  it("none of them acts behind a loading screen, and nothing is kept for the hand-over", () => {
    loading = true; // travelling: the hint state may be up underneath
    expect(r.shown.hint()).toBe(true);
    expect(game.input.inPlay).toBe(false);
    questKey("KeyM");
    questKey("KeyJ");
    press("Digit2");
    press("KeyH");
    game.input.endFrame(); // the paused frame loop ends each input frame
    loading = false; // hand-over
    combatFrame(1000);
    horseFrame();
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(game.input.inPlay).toBe(true);
  });
});

describe("mouse combat needs the lock", () => {
  it("a charge held when the pointer goes is cancelled: no heavy on release, in the hint state or on the next lock", async () => {
    await lockFor(2000);
    mouse("mousedown", 2); // right button: the axe charges
    combatFrame(10_000);
    expect(types()).toEqual(["charge"]);
    expect(sent[0]![1]).toEqual({ on: true });
    // Charged long enough for a heavy, then the browser's Esc: Input reports the button released.
    r.setLock(null);
    vi.advanceTimersByTime(1000); // the pause menu
    combatFrame(12_000);
    expect(sent.at(-1)).toEqual(["charge", { on: false }]);
    r.setGrant(false);
    r.esc(document.body); // back to the game: the re-lock is refused, the hint state
    await r.settle();
    expect(r.shown.hint()).toBe(true);
    combatFrame(12_100);
    await lockFor(100); // the next click locks
    combatFrame(12_200);
    expect(types().filter((t) => t === "melee")).toEqual([]);
    mouse("mouseup", 2);
  });

  it("in the hint state the mouse doesn't charge or attack (a click locks first), keys still work", async () => {
    await toHint();
    mouse("mousedown", 2); // unlocked: the click asks for the lock instead (refused here)
    mouse("mousedown", 0);
    press("Digit3");
    combatFrame(20_000);
    expect(types()).toEqual(["equip"]);
    mouse("mouseup", 0);
    mouse("mouseup", 2);
  });
});

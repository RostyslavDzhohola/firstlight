// Gamepad and touch, wired into the game (D-controls-5, D-controls-6): the gamepad source, menu focus
// navigation, glyph switching, the touch overlay, pause-menu rows for what a pad or a touch screen has
// no button for, and a client system for rumble and the aim slowdown's target test.

import "../ui/controls.css";
import * as THREE from "three/webgpu";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";
import { GamepadSource, type PadSettings } from "./gamepad.ts";
import { FocusNav } from "../ui/focusNav.ts";
import { GlyphSync } from "../ui/glyphs.ts";
import { TouchOverlay, wantsTouch } from "../ui/touchOverlay.ts";
import { pauseExtras } from "../ui/menu.ts";
import { uiSettings, type UiSettings } from "../ui/uiSettings.ts";
import { AIM_SLOWDOWN } from "./padMapping.ts";

/** Pad settings from the stored UI settings. */
export function padSettingsFrom(s: UiSettings): PadSettings {
  return { deadzone: s.padDeadzone, curve: s.padCurve, sensitivity: s.padSensitivity, invertY: s.padInvertY, aimSlow: s.padAimSlow ? AIM_SLOWDOWN : 1, rumble: s.padRumble };
}

export interface Controls {
  pad: GamepadSource;
  nav: FocusNav;
  glyphs: GlyphSync;
  touch: TouchOverlay | null;
  /** The crosshair was on a creep at the last frame (ControlsClient). */
  onTarget: boolean;
}

let installed: Controls | null = null;

/** The controls of the running game (null before Game starts). */
export function controls(): Controls | null {
  return installed;
}

export function installControls(game: Game): Controls {
  const input = game.input;
  const nav = new FocusNav();
  const glyphs = new GlyphSync();
  const c: Controls = { pad: null as unknown as GamepadSource, nav, glyphs, touch: null, onTarget: false };
  const prompt = () => !!game.hud?.promptShown;
  c.pad = new GamepadSource({
    input,
    nav,
    settings: () => padSettingsFrom(uiSettings.get()),
    interactAvailable: prompt,
    selectedSlot: () => game.hud?.you?.selected ?? 0,
    onTarget: () => c.onTarget,
  });
  c.pad.onFamily = (f) => glyphs.set(input.device, f);
  input.onDeviceChange((d) => {
    glyphs.set(d, c.pad.family);
    if (d !== "pad") nav.clearRing();
  });
  c.pad.start();

  if (typeof location !== "undefined" && wantsTouch(location.search)) {
    c.touch = new TouchOverlay({
      input,
      look: () => {
        const s = uiSettings.get();
        return { sensitivity: s.sensitivity, invertY: s.invertY };
      },
      interactAvailable: prompt,
      playing: () => input.device === "touch" && input.captured && !game.combat?.deadUntilRespawn && !game.photo?.active,
    });
    c.touch.start();
    input.setDevice("touch");
  }

  // What a pad or a touch screen has no button for comes from the pause menu (pauseExtras rows are
  // drawn each time the menu opens; each key goes out once the menu has handed back to the game).
  // Two rows per device at most (the menu's list has no room for more): a pad already has inventory
  // (R3), map (Select) and players (Select held); touch has Map and Bag buttons on the overlay.
  const row = (icon: string, title: string, sub: string, code: string, on: readonly string[]) => () =>
    on.includes(input.device) ? { icon, title, sub, onClick: () => queueMicrotask(() => tapKey(code)) } : null;
  const tapKey = (code: string) => {
    input.virtualKey(code, true);
    input.virtualKey(code, false);
  };
  pauseExtras.add(row("book", "Journal", "Missions, medals and the wardrobe", "KeyJ", ["pad", "touch"]));
  pauseExtras.add(row("check", "Tutorial checklist", "Show or hide the first-steps list", "KeyT", ["pad"]));
  pauseExtras.add(row("users", "Players", "Who is here, party invites", "Tab", ["touch"]));
  installed = c;
  return c;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Within this far of the camera ray (m) a creep counts as under the crosshair for the slowdown. */
const SLOW_RADIUS = 1.1;
const SLOW_RANGE = 60;

/**
 * Per body: rumble on taking damage and on a kill (a creep or a player), and the aim slowdown's target
 * test (creeps only, never players: a pad gets no help against a person, D-controls-5).
 */
export function createControlsClient(game: Game): ClientSystem | null {
  const c = installed;
  const room = game.net.room;
  if (!c || !room) return null;
  const me = room.sessionId;
  const offs: (() => void)[] = [];
  const on = <T>(type: string, fn: (m: T) => void) => {
    const off = room.onMessage(type, fn as (m: unknown) => void) as unknown;
    if (typeof off === "function") offs.push(off as () => void);
  };
  on<{ attacker: string; target: string; amount: number }>("hit", (m) => {
    if (m.target === me && m.attacker !== me) c.pad.rumble(Math.min(1, 0.35 + m.amount / 60), 0.25, 140);
  });
  on<{ id: string }>("npcKill", () => c.pad.rumble(0.25, 0.7, 120));
  on<{ victim: string; killer: string | null }>("death", (m) => {
    if (m.killer === me && m.victim !== me) c.pad.rumble(0.4, 0.8, 180);
    else if (m.victim === me) c.pad.rumble(1, 1, 450);
  });
  return {
    update() {
      c.onTarget = false;
      if (game.input.device !== "pad" || !uiSettings.get().padAimSlow || !game.input.captured) return;
      const cam = game.ctx.camera;
      const o = cam.getWorldPosition(_o);
      const d = cam.getWorldDirection(_d);
      const npcs = (room.state as { npcs?: { forEach(fn: (n: { x: number; y: number; z: number; hp?: number }) => void): void } }).npcs;
      npcs?.forEach((n) => {
        if (c.onTarget || (n.hp ?? 1) <= 0) return;
        _v.set(n.x, n.y, n.z);
        _v.addScaledVector(_v.clone().normalize(), 0.9).sub(o);
        const along = _v.dot(d);
        if (along < 2 || along > SLOW_RANGE) return;
        if (_v.addScaledVector(d, -along).length() < SLOW_RADIUS) c.onTarget = true;
      });
    },
    dispose() {
      for (const off of offs) off();
      c.onTarget = false;
    },
  };
}

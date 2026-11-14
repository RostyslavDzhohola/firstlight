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
import { AIM_SLOWDOWN, MENU_KEY_ROWS } from "./padMapping.ts";
import { crosshairQueryOf, crosshairTarget } from "./crosshairTarget.ts";

/** Pad settings from the stored UI settings. */
export function padSettingsFrom(s: UiSettings): PadSettings {
  return { deadzone: s.padDeadzone, curve: s.padCurve, sensitivity: s.padSensitivity, invertY: s.padInvertY, aimSlow: s.padAimSlow ? AIM_SLOWDOWN : 1, rumble: s.padRumble };
}

export interface Controls {
  pad: GamepadSource;
  nav: FocusNav;
  glyphs: GlyphSync;
  touch: TouchOverlay | null;
  /** The nearest unobstructed thing under the crosshair is a creature (ControlsClient sets the query). */
  aimTarget: () => boolean;
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
  const c: Controls = { pad: null as unknown as GamepadSource, nav, glyphs, touch: null, aimTarget: () => false };
  const prompt = () => !!game.hud?.promptShown;
  c.pad = new GamepadSource({
    input,
    nav,
    settings: () => padSettingsFrom(uiSettings.get()),
    interactAvailable: prompt,
    selectedSlot: () => game.hud?.you?.selected ?? 0,
    onTarget: () => c.aimTarget(),
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

  // What a pad or a touch screen has no button for comes from the pause menu (MENU_KEY_ROWS; the
  // pauseExtras rows are drawn each time the menu opens; each key goes out once the menu has handed
  // back to the game).
  const tapKey = (code: string) => {
    input.virtualKey(code, true, "menu");
    input.virtualKey(code, false, "menu");
  };
  for (const r of MENU_KEY_ROWS)
    pauseExtras.add(() => ((r.on as readonly string[]).includes(input.device) ? { icon: r.icon, title: r.title, sub: r.sub, onClick: () => queueMicrotask(() => tapKey(r.code)) } : null));
  installed = c;
  return c;
}

/** How far the aim slowdown looks along the crosshair (m). */
const SLOW_RANGE = 60;
const _hit = new THREE.Vector3();

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
  // The slowdown asks only while the right stick turns (GamepadSource), at most once per poll, with the
  // crosshair's own query: a creature counts only as the nearest unobstructed thing (review #9).
  c.aimTarget = () => game.input.captured && crosshairTarget(crosshairQueryOf(game), SLOW_RANGE, _hit).kind === "npc";
  return {
    update() {},
    dispose() {
      for (const off of offs) off();
      c.aimTarget = () => false;
    },
  };
}

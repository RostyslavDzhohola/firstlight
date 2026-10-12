// Connect the UI to the running game: the Low graphics tier turns UI blur off (`fl-lowfx` on <html>),
// and the player's control settings drive the input and the camera.

import type { Game } from "../game/Game.ts";
import type { ResolvedSettings } from "../render/quality.ts";
import { BASE_SENSITIVITY, uiSettings, type UiSettings } from "./uiSettings.ts";

/** Backdrop blur is the most expensive thing in the UI; Low drops it (verdict fix 6). */
export function applyUiFx(s: Pick<ResolvedSettings, "tier">): void {
  document.documentElement.classList.toggle("fl-lowfx", s.tier === "low");
}

export function bindUi(game: Game): void {
  applyUiFx(game.ctx.settings);
  game.ctx.onChange((s) => applyUiFx(s));
  const controls = (s: UiSettings) => {
    game.input.sensitivity = BASE_SENSITIVITY * s.sensitivity;
    game.input.invertY = s.invertY;
    game.combat.baseFov = s.fov;
  };
  controls(uiSettings.get());
  uiSettings.onChange(controls);
}

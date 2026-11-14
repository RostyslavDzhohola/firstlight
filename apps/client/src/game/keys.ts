// Key bindings (SPEC §4.4). No F-keys (D-controls-2): on a Mac F1–F12 belong to the system (F3 is
// Mission Control, Fn may be taken by other apps), so the overlays moved to keys that are free there.
// BINDINGS lists every key the game reads while playing, so a new binding can be checked against all
// of them (keys.test.ts).

export interface Hotkey {
  /** KeyboardEvent.code */
  code: string;
  /** Needs Shift held (true) or not held (false/absent). */
  shift?: boolean;
  /** Keycaps for menus and cards. */
  caps: readonly string[];
}

export const HOTKEYS = {
  /** Performance overlay (was F3). */
  perf: { code: "Backquote", caps: ["`"] },
  /** Photo mode on and off (was F9). */
  photo: { code: "KeyP", shift: true, caps: ["Shift", "P"] },
  screenshot: { code: "KeyP", caps: ["P"] },
  /** Admins only (was `, now taken by the performance overlay). */
  adminConsole: { code: "Backquote", shift: true, caps: ["Shift", "`"] },
  /** First / third person (D-view-fp-1): V, the genre's key. Push to talk moved to K. */
  view: { code: "KeyV", caps: ["V"] },
  /** Push to talk while voice chat is on (hidden in this build, D-controls-1); was V. */
  pushToTalk: { code: "KeyK", caps: ["K"] },
} as const satisfies Record<string, Hotkey>;

/** Does a key press (code + Shift state) hit this hotkey? Shift must match exactly. */
export function hits(k: Hotkey, code: string, shift: boolean): boolean {
  return code === k.code && !!k.shift === shift;
}

export interface Binding {
  code: string;
  shift?: boolean;
  what: string;
  /** Only while voice chat is on (hidden in this build, D-controls-1). */
  voice?: boolean;
}

/** Every key the game reads while playing (not photo mode, not inside panels). */
export const BINDINGS: readonly Binding[] = [
  { code: "KeyW", what: "move" },
  { code: "KeyA", what: "move" },
  { code: "KeyS", what: "move" },
  { code: "KeyD", what: "move" },
  { code: "Space", what: "jump" },
  { code: "ShiftLeft", what: "sprint" },
  { code: "ShiftRight", what: "sprint" },
  { code: "KeyC", what: "dodge-roll" },
  { code: "KeyR", what: "reload" },
  { code: "Digit1", what: "weapon 1 / phrase 1" },
  { code: "Digit2", what: "weapon 2 / phrase 2" },
  { code: "Digit3", what: "weapon 3 / phrase 3" },
  { code: "Digit4", what: "weapon 4 / phrase 4" },
  { code: "KeyE", what: "interact, pick up, ride" },
  { code: "KeyG", what: "phrase wheel" },
  { code: "KeyH", what: "whistle a horse" },
  { code: "KeyI", what: "inventory" },
  { code: "KeyJ", what: "journal" },
  { code: "KeyM", what: "map" },
  { code: "KeyT", what: "tutorial checklist" },
  { code: "KeyY", what: "accept an invite" },
  { code: "KeyN", what: "decline an invite" },
  { code: "Tab", what: "players" },
  { code: "Escape", what: "pause menu" },
  { code: HOTKEYS.screenshot.code, what: "screenshot" },
  { code: HOTKEYS.photo.code, shift: true, what: "photo mode" },
  { code: HOTKEYS.perf.code, what: "performance overlay" },
  { code: HOTKEYS.adminConsole.code, shift: true, what: "admin console" },
  // The spellbook (content/spells.ts SPELLS: the codes are checked against it in keys.test.ts).
  { code: "KeyQ", what: "spell: Skipstep" },
  { code: "KeyF", what: "spell: Frostbloom" },
  { code: "KeyX", what: "spell: Wishfall" },
  { code: "KeyZ", what: "spell: Glasswing Ward" },
  { code: HOTKEYS.pushToTalk.code, what: "push to talk", voice: true },
  { code: "KeyB", what: "radio", voice: true },
  { code: "Escape", shift: true, what: "mute everyone", voice: true },
  { code: HOTKEYS.view.code, what: "first / third person" },
  { code: "KeyL", what: "missions panel: collapse / expand (#69)" },
  { code: "KeyL", shift: true, what: "track the next mission (#69)" },
];

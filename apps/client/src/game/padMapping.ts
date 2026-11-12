// Gamepad mapping (D-controls-5): pure functions and tables, no DOM. gamepad.ts polls the browser's
// Gamepad API and feeds Input with what these say. Standard mapping only (Xbox, PlayStation and Switch
// Pro pads in Chrome, Edge, Firefox and Safari all report it); button indexes follow the W3C
// "standard" layout: 0 bottom face, 1 right face, 2 left face, 3 top face, 4/5 bumpers, 6/7 triggers,
// 8 back/select, 9 start, 10/11 stick clicks, 12–15 D-pad up/down/left/right, 16 home.

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;
export type Btn = (typeof BTN)[keyof typeof BTN];

/** What a pad action does in play. `key` actions send that key code (Input.virtualKey). */
export type PadAction =
  | { kind: "key"; code: string }
  | { kind: "attack" }
  | { kind: "alt" }
  /** X: interact when a prompt is up (E), otherwise reload (R). */
  | { kind: "interact" }
  /** LB/RB: the previous or next hotbar slot (sends Digit1–4). */
  | { kind: "hotbar"; step: -1 | 1 }
  /** Left stick click: sprint until the stick is let go (the key is held as Shift). */
  | { kind: "sprint" }
  /** Select: a tap opens the map (M), a hold peeks the players list (Tab held). */
  | { kind: "select" };

/**
 * The final layout (D-controls-5). D-pad left/up/right/down cast the spellbar's four slots left to
 * right (Q F X Z), so the D-pad reads like the bar. Every play binding in keys.ts BINDINGS that a pad
 * player needs is here or in the pause menu (pauseRows in controls.ts: inventory, journal, tutorial).
 */
export const PAD_LAYOUT: ReadonlyMap<Btn, PadAction> = new Map<Btn, PadAction>([
  [BTN.A, { kind: "key", code: "Space" }],
  [BTN.B, { kind: "key", code: "KeyC" }],
  [BTN.X, { kind: "interact" }],
  [BTN.Y, { kind: "key", code: "KeyH" }],
  [BTN.RT, { kind: "attack" }],
  [BTN.LT, { kind: "alt" }],
  [BTN.LB, { kind: "hotbar", step: -1 }],
  [BTN.RB, { kind: "hotbar", step: 1 }],
  [BTN.LEFT, { kind: "key", code: "KeyQ" }],
  [BTN.UP, { kind: "key", code: "KeyF" }],
  [BTN.RIGHT, { kind: "key", code: "KeyX" }],
  [BTN.DOWN, { kind: "key", code: "KeyZ" }],
  [BTN.START, { kind: "key", code: "Escape" }],
  [BTN.SELECT, { kind: "select" }],
  [BTN.LS, { kind: "sprint" }],
  [BTN.RS, { kind: "key", code: "KeyI" }],
]);

/** Triggers count as pressed past this (they are analog 0..1). */
export const TRIGGER_ON = 0.35;
/** A pressed trigger counts as let go only below this (hysteresis: noise near TRIGGER_ON doesn't flutter, review #5). */
export const TRIGGER_OFF = 0.2;
/** Select held this long peeks the players list instead of opening the map. */
export const SELECT_HOLD_MS = 400;

export interface StickTuning {
  /** Radial dead zone, 0..1 of the stick's throw. */
  deadzone: number;
  /** Response curve exponent (1 linear; 2 gives fine aim near the centre). */
  curve: number;
}

/**
 * Radial dead zone with rescaling: inside `deadzone` the stick reads zero; outside, the remaining
 * throw is rescaled to 0..1 along the same direction (so there is no jump at the edge and diagonals
 * keep their angle), then shaped by the response curve. The result's length is at most 1.
 */
export function shapeStick(x: number, y: number, t: StickTuning): { x: number; y: number; mag: number } {
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len <= t.deadzone) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (len - t.deadzone) / (1 - t.deadzone));
  const mag = Math.pow(scaled, t.curve);
  return { x: (x / len) * mag, y: (y / len) * mag, mag };
}

/** Full-deflection turn rate of the look stick at sensitivity 1, radians per second (about 200°/s yaw). */
export const LOOK_RATE = { yaw: 3.5, pitch: 2.2 };
/** Aim slowdown over a target: the look rate's factor while the crosshair is on an enemy (no pull). */
export const AIM_SLOWDOWN = 0.6;

/**
 * Camera turn for one frame from the shaped look stick (radians; +yaw right, +pitch up). Pushing the
 * stick up looks up unless inverted. `slow` is the aim slowdown factor (1: none).
 */
export function lookFromStick(sx: number, sy: number, dt: number, sensitivity: number, invertY: boolean, slow = 1): { yaw: number; pitch: number } {
  const k = sensitivity * slow * dt;
  return { yaw: sx * LOOK_RATE.yaw * k, pitch: (invertY ? sy : -sy) * LOOK_RATE.pitch * k };
}

/** The next hotbar slot (0..3) from `selected`, wrapping. */
export function hotbarStep(selected: number, step: -1 | 1, slots = 4): number {
  return (((selected + step) % slots) + slots) % slots;
}

/** Face-button labels differ by maker; positions don't (standard mapping). */
export type PadFamily = "xbox" | "playstation" | "nintendo";

export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/054c|dualsense|dualshock|playstation/.test(s)) return "playstation";
  if (/057e|nintendo|pro controller|joy-con/.test(s)) return "nintendo";
  return "xbox";
}

const FACE: Record<PadFamily, Record<"A" | "B" | "X" | "Y" | "LB" | "RB" | "LT" | "RT" | "LS" | "RS" | "START" | "SELECT", string>> = {
  xbox: { A: "A", B: "B", X: "X", Y: "Y", LB: "LB", RB: "RB", LT: "LT", RT: "RT", LS: "LS", RS: "RS", START: "☰", SELECT: "⧉" },
  playstation: { A: "✕", B: "○", X: "□", Y: "△", LB: "L1", RB: "R1", LT: "L2", RT: "R2", LS: "L3", RS: "R3", START: "Options", SELECT: "Create" },
  // Nintendo prints B at the bottom and A on the right: the labels follow the position.
  nintendo: { A: "B", B: "A", X: "Y", Y: "X", LB: "L", RB: "R", LT: "ZL", RT: "ZR", LS: "LS", RS: "RS", START: "+", SELECT: "−" },
};
const DPAD = { UP: "D↑", DOWN: "D↓", LEFT: "D←", RIGHT: "D→" };

/**
 * The pad glyph for a keyboard keycap as the HUD, tutorial and menus print it ("E", "Space", "LMB"…).
 * null: no glyph (the keycap is hidden for a pad player). One table so every prompt switches together.
 */
export function padGlyph(cap: string, family: PadFamily): string | null {
  const f = FACE[family];
  switch (cap.trim().toUpperCase()) {
    case "W":
      return "LS";
    case "A":
    case "S":
    case "D":
      return null; // W shows the stick; the others hide
    case "MOUSE":
    case "MOUSE-MOVE":
      return f.RS === "RS" ? "RS" : "R-stick";
    case "SPACE":
      return f.A;
    case "SHIFT":
      return f.LS === "L3" ? "L3" : "LS ●";
    case "C":
      return f.B;
    case "E":
    case "R":
      return f.X;
    case "H":
      return f.Y;
    case "LMB":
    case "MOUSE-L":
      return f.RT;
    case "RMB":
    case "MOUSE-R":
      return f.LT;
    case "1":
    case "2":
    case "3":
    case "4":
      return `${f.LB}/${f.RB}`;
    case "Q":
      return DPAD.LEFT;
    case "F":
      return DPAD.UP;
    case "X":
      return DPAD.RIGHT;
    case "Z":
      return DPAD.DOWN;
    case "ESC":
    case "ESCAPE":
      return f.START;
    case "M":
      return f.SELECT;
    case "TAB":
      return `${f.SELECT} hold`;
    case "I":
      return f.RS === "RS" ? "RS ●" : f.RS;
    case "J":
    case "T":
      return f.START;
    default:
      return null;
  }
}

/** The touch overlay's button for a keycap (touch shows the button's word, not a key). */
export function touchGlyph(cap: string): string | null {
  switch (cap.trim().toUpperCase()) {
    case "W":
      return "Stick";
    case "A":
    case "S":
    case "D":
      return null;
    case "MOUSE":
    case "MOUSE-MOVE":
      return "Drag";
    case "SPACE":
      return "Jump";
    case "SHIFT":
      return "Push far";
    case "C":
      return "Roll";
    case "E":
      return "Use";
    case "R":
      return "Reload";
    case "LMB":
    case "MOUSE-L":
      return "Fire";
    case "RMB":
    case "MOUSE-R":
      return "Alt";
    case "1":
    case "2":
    case "3":
    case "4":
      return "Tap slot";
    case "Q":
    case "F":
    case "X":
    case "Z":
      return "Spell";
    case "M":
      return "Map";
    case "ESC":
    case "ESCAPE":
    case "I":
    case "J":
    case "T":
      return "☰";
    case "H":
      return "☰";
    default:
      return null;
  }
}

/** How to play rows for a pad (the pause menu's How to play and Settings), in the family's labels. */
export function padControls(family: PadFamily): { title: string; rows: [string, string][] }[] {
  const f = FACE[family];
  return [
    { title: "Move", rows: [["LS", "Move (push lightly to walk)"], [f.RS === "RS" ? "RS" : "R-stick", "Look"], [f.A, "Jump"], [f.LS === "LS" ? "LS ●" : f.LS, "Sprint (click the stick)"], [f.B, "Dodge-roll"]] },
    { title: "Fight", rows: [[f.RT, "Attack"], [f.LT, "Aim · block · draw · charge"], [`${f.LB} · ${f.RB}`, "Previous · next weapon"], [f.X, "Reload (nothing to use nearby)"]] },
    { title: "World", rows: [[f.X, "Interact · pick up · ride"], [f.Y, "Whistle a horse"], [f.SELECT, "Map"], [`${f.SELECT} hold`, "Players"], [f.RS === "RS" ? "RS ●" : f.RS, "Inventory"], [f.START, "Menu · journal · tutorial"]] },
    { title: "Spells", rows: [["D← · D↑ · D→ · D↓", "The spellbar, left to right"]] },
    { title: "Menus", rows: [["D-pad · LS", "Move the focus"], [f.A, "Choose"], [f.B, "Back"]] },
  ];
}

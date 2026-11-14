// The orrery menu's model (D-menu-1): where the four bodies are, where the camera stands, what is in
// front, and what the plate beside the front world says. Pure: no DOM, no WebGL (home/orrery.ts draws it).
//
// The menu is the sky itself: a star in the middle, the hub and the three planets on their rings,
// turned by hand. The world at the front is the chosen one; diving into it is Play.

import type { BodyId } from "@firstlight/shared/planet/bodies";
import type { HomeBoard, HomeOnline } from "@firstlight/shared/net/home";
import { fmtNum, worldCards, type MeInfo, type WorldCard } from "./homeModel.ts";

export interface OrreryBody {
  id: BodyId;
  /** Ring radius and body radius (scene units), ring speed (rad/s) and starting angle (rad). */
  orbit: number;
  radius: number;
  speed: number;
  phase: number;
}

/** Inner to outer. The order is also the shader's body index. */
export const ORRERY_BODIES: readonly OrreryBody[] = [
  { id: "portus", orbit: 3.4, radius: 0.5, speed: 0.021, phase: 0.6 },
  { id: "arcadia", orbit: 5.6, radius: 0.86, speed: 0.013, phase: 2.5 },
  { id: "hollowmere", orbit: 8.0, radius: 1.0, speed: 0.009, phase: 4.3 },
  { id: "meridian", orbit: 10.6, radius: 1.16, speed: 0.006, phase: 5.6 },
];

export type V3 = readonly [number, number, number];

/** The angle (from +x towards +z) where the front world sits: towards the camera, a little left of centre. */
export const FRONT = Math.PI / 2 + 0.2;
const TAU = Math.PI * 2;

/** `a` wrapped into −π…π. */
export function wrapAngle(a: number): number {
  const w = (((a + Math.PI) % TAU) + TAU) % TAU;
  return w - Math.PI;
}

/** A body's angle on its ring at `t` seconds with the sky turned by `yaw`. */
export function bodyAngle(b: OrreryBody, t: number, yaw: number): number {
  return b.phase + b.speed * t + yaw;
}

export function bodyPos(b: OrreryBody, t: number, yaw: number): V3 {
  const a = bodyAngle(b, t, yaw);
  return [b.orbit * Math.cos(a), 0, b.orbit * Math.sin(a)];
}

/** The body nearest the front of the sky (index into ORRERY_BODIES). */
export function frontBody(t: number, yaw: number): number {
  let best = 0;
  let bestD = Infinity;
  ORRERY_BODIES.forEach((b, i) => {
    const d = Math.abs(wrapAngle(bodyAngle(b, t, yaw) - FRONT));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The yaw nearest `from` that puts body `i` at the front at time `t`. */
export function yawFor(i: number, t: number, from: number): number {
  const b = ORRERY_BODIES[i]!;
  return from + wrapAngle(FRONT - bodyAngle(b, t, from));
}

/** The next world round the sky from `i` (dir +1: the one that arrives from the right). */
export function neighbour(i: number, dir: 1 | -1, t: number, yaw: number): number {
  const here = bodyAngle(ORRERY_BODIES[i]!, t, yaw);
  let best = i;
  let bestD = Infinity;
  ORRERY_BODIES.forEach((b, k) => {
    if (k === i) return;
    // Angular distance going one way round only (0…2π).
    const d = (((dir * (here - bodyAngle(b, t, yaw))) % TAU) + TAU) % TAU;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

export interface OrreryCamera {
  pos: V3;
  fwd: V3;
  right: V3;
  up: V3;
  /** tan(fov / 2), vertical. */
  tan: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mix = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

export const ORRERY_FOV_TAN = Math.tan((34 * Math.PI) / 360);

/**
 * The camera for a front world at `p` with radius `r`: it stands off the world's near side, a little
 * above the rings, and looks past it so the world sits left of centre with the star and the other
 * worlds behind. `dive` 0…1 flies it down to the surface.
 */
export function orreryCamera(p: V3, r: number, dive = 0): OrreryCamera {
  const out = norm([p[0], 0, p[2]]);
  const perp: V3 = [-out[2], 0, out[0]];
  // Off to one side of the world rather than straight out from the star: the camera sees most of
  // its lit face, and the star and the inner worlds stand behind it on the right.
  const a = (68 * Math.PI) / 180;
  const from = norm(add(mul(out, Math.cos(a)), mul(perp, -Math.sin(a))));
  const dist = 4.7 * Math.pow(r, 0.8) + 2.1;
  const stand = add(add(p, mul(from, dist)), [0, 0.95 + r * 0.5, 0]);
  const right0 = norm(cross(norm(sub(p, stand)), [0, 1, 0]));
  const look = add(add(p, mul(right0, r * 1.35 + 0.8)), [0, -0.05, 0]);
  const k = dive * dive * (3 - 2 * dive);
  const pos = mix(stand, add(p, mul(norm(sub(stand, p)), r * 1.04)), k);
  const target = mix(look, p, k);
  const fwd = norm(sub(target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { pos, fwd, right, up, tan: ORRERY_FOV_TAN };
}

export interface Projected {
  x: number;
  y: number;
  /** Distance along the view axis; ≤ 0 is behind the camera. */
  depth: number;
  /** Pixels per scene unit at that depth. */
  scale: number;
}

/** A scene point on a `w` × `h` screen (CSS pixels, y down). */
export function project(p: V3, cam: OrreryCamera, w: number, h: number): Projected {
  const d = sub(p, cam.pos);
  const z = dot(d, cam.fwd);
  const scale = h / 2 / (cam.tan * Math.max(z, 1e-4));
  return { x: w / 2 + dot(d, cam.right) * scale, y: h / 2 - dot(d, cam.up) * scale, depth: z, scale };
}

/** The body under a screen point (the nearest one whose disc holds it, with a little slack), or −1. */
export function pickBody(x: number, y: number, t: number, yaw: number, cam: OrreryCamera, w: number, h: number): number {
  let best = -1;
  let bestDepth = Infinity;
  ORRERY_BODIES.forEach((b, i) => {
    const s = project(bodyPos(b, t, yaw), cam, w, h);
    if (s.depth <= 0) return;
    const r = Math.max(b.radius * s.scale * 1.12, 14);
    if (Math.hypot(x - s.x, y - s.y) <= r && s.depth < bestDepth) {
      bestDepth = s.depth;
      best = i;
    }
  });
  return best;
}

// ------------------------------------------------------------------------------------ the plate

export interface OrreryPlate {
  kicker: string;
  name: string;
  line: string;
  /** Short facts under the line: who is here, what waits. */
  facts: string[];
  /** The world Play goes to: dive in. Otherwise how to get here, and the world to turn to instead. */
  action: { kind: "dive"; label: string } | { kind: "route"; note: string; go: BodyId; goLabel: string };
}

const NAME: Record<BodyId, string> = { portus: "Portus", arcadia: "Arcadia", hollowmere: "Hollowmere", meridian: "Meridian", lumen: "Lumen" };
/** The colour of each world's portal in the Portus plaza (what a new traveller is told to look for). */
const PORTAL: Partial<Record<BodyId, string>> = { arcadia: "cyan", hollowmere: "violet", meridian: "amber" };

function hereNow(card: WorldCard, online: HomeOnline | null): string {
  const names = online?.bodies[card.id]?.names ?? [];
  if (!card.players) return "Nobody here right now";
  if (!names.length) return `${fmtNum(card.players)} here now`;
  const shown = names.slice(0, 3);
  const rest = card.players - shown.length;
  return `${fmtNum(card.players)} here now: ${shown.join(", ")}${rest > 0 ? ` and ${fmtNum(rest)} more` : ""}`;
}

/** The world Play enters: where the character stands, or the hub for a new traveller. */
export function enterBody(me: MeInfo | null): BodyId {
  const b = me?.character?.body;
  return b === "arcadia" || b === "hollowmere" || b === "meridian" || b === "portus" ? b : "portus";
}

export function orreryPlate(id: BodyId, online: HomeOnline | null, me: MeInfo | null): OrreryPlate {
  const card = worldCards(online).find((c) => c.id === id)!;
  const enter = enterBody(me);
  const facts = [hereNow(card, online)];
  if (card.boss) facts.push(`${card.boss.name} waits here · level ${card.boss.level}`);
  else facts.push("Safe inside the walls · three portals in the plaza");
  const kicker = id === "portus" ? `The hub · ${card.levels}` : `Planet · ${card.levels}`;
  let action: OrreryPlate["action"];
  if (id === enter) {
    const c = me?.character;
    const who = me?.displayName ?? me?.name;
    action = { kind: "dive", label: c ? `Continue${who ? ` as ${who}` : ""} · level ${c.level}` : "Begin here" };
  } else if (me?.character) {
    action = { kind: "route", note: `You are on ${NAME[enter]}. Portals and pads lead here.`, go: enter, goLabel: `Turn to ${NAME[enter]}` };
  } else {
    const portal = PORTAL[id];
    action = { kind: "route", note: `Every traveller starts in Portus.${portal ? ` Its ${portal} portal leads here.` : ""}`, go: "portus", goLabel: "Turn to Portus" };
  }
  return { kicker, name: card.name, line: card.line, facts, action };
}

/** Lines the almanac in the corner turns through: what is true in the worlds right now. */
export function almanacLines(online: HomeOnline | null, board: HomeBoard | null): string[] {
  const out: string[] = [];
  out.push(online && online.total > 0 ? `${fmtNum(online.total)} ${online.total === 1 ? "traveller is" : "travellers are"} awake right now` : "The worlds are quiet. Be the first one in.");
  const top = board?.levels[0];
  if (top) out.push(`${top.name} leads the travellers at level ${top.level}`);
  const g = board?.gleams;
  if (g) out.push(g.first[0] ? `${g.first[0].name} was first to open the Gleam Vault · ${fmtNum(g.keepers)} since` : "The Gleam Vault has never been opened");
  out.push("One life: fall, and everything you carried stays where you fell");
  out.push("Humans and AI agents walk these worlds side by side");
  return out;
}

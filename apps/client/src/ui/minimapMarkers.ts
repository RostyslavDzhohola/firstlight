// Minimap markers that move or can be far away (pure, no DOM; ui/minimap.ts draws through these
// with its canvas): mission stars, party members and the waypoint. A marker stands on its spot only
// when it is within the minimap's range by surface distance and on the near side of the globe; a
// target on the far side projects back into the middle, so the projected distance can't decide.
// Far markers that pin go on the rim toward their bearing; far mission stars are left off.

import { surfaceDistance, type V3 } from "../social/compassMath.ts";
import { project, screenAngle, type MapView } from "./mapView.ts";

export interface MiniPlace {
  x: number;
  y: number;
  /** On the rim, pointing at something beyond the shown range. */
  pinned: boolean;
}

const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/**
 * Where `target` goes on a minimap view centred on you (`me`, both unit directions): its projected
 * spot when within `range` metres and inside `rim` pixels of the centre, else on the rim toward it
 * (if `pin`), else null.
 */
export function minimapPlace(v: MapView, me: V3, target: V3, radius: number, range: number, rim: number, pin: boolean): MiniPlace | null {
  const cx = v.w / 2, cy = v.h / 2;
  const s = project(v, target);
  if (s.z > 0 && surfaceDistance(me, target, radius) <= range && Math.hypot(s.x - cx, s.y - cy) <= rim) return { x: s.x, y: s.y, pinned: false };
  if (!pin) return null;
  // The great circle's first step from you toward the target, in the view's screen frame.
  const k = target[0] * me[0] + target[1] * me[1] + target[2] * me[2];
  const a = screenAngle(v, [target[0] - k * me[0], target[1] - k * me[1], target[2] - k * me[2]]);
  return { x: cx + Math.sin(a) * rim, y: cy - Math.cos(a) * rim, pinned: true };
}

export function drawMissionStars(ctx: CanvasRenderingContext2D, v: MapView, me: V3, targets: readonly { dir: V3 }[], radius: number, range: number, rim: number): MiniPlace[] {
  const out: MiniPlace[] = [];
  for (const t of targets) {
    const p = minimapPlace(v, me, t.dir, radius, range, rim, false);
    if (!p) continue;
    star(ctx, p.x, p.y, 5, "#ffd166");
    out.push(p);
  }
  return out;
}

/** Party members at world positions; the far ones sit on the rim toward them. */
export function drawPartyMarkers(ctx: CanvasRenderingContext2D, v: MapView, me: V3, members: readonly { pos: readonly number[]; colour: string }[], radius: number, range: number, rim: number): MiniPlace[] {
  const out: MiniPlace[] = [];
  for (const m of members) {
    const p = minimapPlace(v, me, unit(m.pos), radius, range, rim - 4, true)!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = m.colour;
    ctx.strokeStyle = "#0b1016";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    out.push(p);
  }
  return out;
}

export function drawWaypointMarker(ctx: CanvasRenderingContext2D, v: MapView, me: V3, wp: V3, radius: number, range: number, rim: number, colour: string): MiniPlace {
  const p = minimapPlace(v, me, wp, radius, range, rim - 5, true)!;
  diamond(ctx, p.x, p.y, p.pinned ? 4.5 : 5.5, colour);
  return p;
}

/** Your arrow: white with a dark edge, pointing `angle` radians clockwise from up. */
export function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, r: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.72, r * 0.8);
  ctx.lineTo(0, r * 0.38);
  ctx.lineTo(-r * 0.72, r * 0.8);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

export function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

export function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

// Where a world callout goes on screen (pure, unit-tested): on its point while that is on screen,
// otherwise pinned to the screen edge with an arrow towards it; never over the tutorial panel.

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface CalloutPlacement {
  x: number;
  y: number;
  /** Pinned with an arrow instead of standing on its point. */
  edge: boolean;
  /** Arrow direction in screen space (radians, 0 = right, y down). */
  angle: number;
  /** Label on the left of its point or arrow, so it stays on screen near the right edge. */
  flip: boolean;
}

/** Edge-arrow clearance: the compass at the top, the hotbar and player card at the bottom. */
const MARGIN = { left: 28, right: 28, top: 90, bottom: 160 };
const ON_SCREEN = 0.95;
/** Space between the tutorial panel and a callout moved out from under it. */
const GAP = 24;
/** The label's offsets as kit.css and onboarding.css draw them: beside the dot, or beside the arrow. */
const DOT_LABEL = { side: 10, up: 78 };
const ARROW_LABEL = 16;

/**
 * `ndc` is three's `Vector3.project()` result: x and y in −1…1 on screen, z > 1 behind the camera
 * (where x and y come out mirrored). `box` is the label's size; `avoid` the open tutorial panel.
 */
export function placeCallout(ndc: { x: number; y: number; z: number }, w: number, h: number, box: { w: number; h: number }, avoid: Rect | null): CalloutPlacement {
  // A point on the camera plane projects to infinities: keep its side, never NaN.
  const finite = Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
  const behind = finite && ndc.z > 1;
  const nx = (behind ? -1 : 1) * bounded(ndc.x);
  const ny = (behind ? -1 : 1) * bounded(ndc.y);
  const px = (nx * 0.5 + 0.5) * w;
  const py = (-ny * 0.5 + 0.5) * h;
  if (finite && !behind && Math.abs(nx) < ON_SCREEN && Math.abs(ny) < ON_SCREEN) {
    const flip = px + DOT_LABEL.side + box.w > w - 8;
    const r = flip
      ? { left: px - DOT_LABEL.side - box.w, top: py - DOT_LABEL.up, right: px + 6, bottom: py + 6 }
      : { left: px - 6, top: py - DOT_LABEL.up, right: px + DOT_LABEL.side + box.w, bottom: py + 6 };
    if (!avoid || !overlaps(r, avoid)) return { x: px, y: py, edge: false, angle: 0, flip };
    // Beside the panel, pointing back at the point behind it.
    const ax = avoid.right + GAP;
    const ay = clamp(py, MARGIN.top, h - MARGIN.bottom);
    return { x: ax, y: ay, edge: true, angle: Math.atan2(py - ay, px - ax), flip: flipBeside(ax, w, box, avoid) };
  }
  // Off screen or behind: along the ray from the centre out to the margin rectangle, pointing outward.
  const cx = w / 2;
  const cy = h / 2;
  let dx = px - cx;
  let dy = py - cy;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = 0;
    dy = 1; // dead behind: point down
  }
  const sx = dx > 0 ? (w - MARGIN.right - cx) / dx : dx < 0 ? (MARGIN.left - cx) / dx : Infinity;
  const sy = dy > 0 ? (h - MARGIN.bottom - cy) / dy : dy < 0 ? (MARGIN.top - cy) / dy : Infinity;
  const s = Math.min(sx, sy);
  let ex = cx + dx * s;
  const ey = cy + dy * s;
  if (avoid && ex >= avoid.left - GAP && ex <= avoid.right + GAP && ey >= avoid.top - GAP && ey <= avoid.bottom + GAP) ex = avoid.right + GAP;
  return { x: ex, y: ey, edge: true, angle: Math.atan2(dy, dx), flip: flipBeside(ex, w, box, avoid) };
}

/** Label left of the arrow only when it doesn't fit on the right and the left side is clear of the panel. */
function flipBeside(x: number, w: number, box: { w: number }, avoid: Rect | null): boolean {
  if (x + ARROW_LABEL + box.w <= w - 8) return false;
  const left = x - ARROW_LABEL - box.w;
  return left >= 8 && !(avoid && left < avoid.right && x > avoid.left);
}

function bounded(v: number): number {
  return Number.isNaN(v) ? 0 : Math.max(-1e6, Math.min(1e6, v));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

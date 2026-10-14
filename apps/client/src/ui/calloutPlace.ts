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
  /** Label on the left of the arrow, so it stays on screen near the right edge. */
  flip: boolean;
}

/** Edge-arrow clearance: the compass at the top, the hotbar and player card at the bottom. */
const MARGIN = { left: 28, right: 28, top: 90, bottom: 160 };
const ON_SCREEN = 0.95;
/** Space between the tutorial panel and a callout moved out from under it. */
const GAP = 24;

/**
 * `ndc` is three's `Vector3.project()` result: x and y in −1…1 on screen, z > 1 behind the camera
 * (where x and y come out mirrored). `box` is the label's size; `avoid` the open tutorial panel.
 */
export function placeCallout(ndc: { x: number; y: number; z: number }, w: number, h: number, box: { w: number; h: number }, avoid: Rect | null): CalloutPlacement {
  const behind = ndc.z > 1;
  const nx = behind ? -ndc.x : ndc.x;
  const ny = behind ? -ndc.y : ndc.y;
  const px = (nx * 0.5 + 0.5) * w;
  const py = (-ny * 0.5 + 0.5) * h;
  if (!behind && Math.abs(nx) < ON_SCREEN && Math.abs(ny) < ON_SCREEN) {
    // The label's box as kit.css draws it: 10 px right of the dot, 78 px up.
    const r = { left: px - 6, top: py - 78, right: px + 10 + box.w, bottom: py + 6 };
    if (!avoid || !overlaps(r, avoid)) return { x: px, y: py, edge: false, angle: 0, flip: false };
    return pointer(px, py, avoid.right + GAP, clamp(py, MARGIN.top, h - MARGIN.bottom), w);
  }
  // Off screen or behind: from the centre towards the point, out to the margin rectangle.
  const cx = w / 2;
  const cy = h / 2;
  const dx = px - cx;
  const dy = Math.abs(px - cx) < 1e-6 && Math.abs(py - cy) < 1e-6 ? 1 : py - cy; // dead behind: point down
  const sx = dx > 0 ? (w - MARGIN.right - cx) / dx : dx < 0 ? (MARGIN.left - cx) / dx : Infinity;
  const sy = dy > 0 ? (h - MARGIN.bottom - cy) / dy : dy < 0 ? (MARGIN.top - cy) / dy : Infinity;
  const s = Math.min(sx, sy);
  let ex = cx + dx * s;
  const ey = cy + dy * s;
  if (avoid && ex >= avoid.left - GAP && ex <= avoid.right + GAP && ey >= avoid.top - GAP && ey <= avoid.bottom + GAP) ex = avoid.right + GAP;
  return pointer(cx + dx * 4, cy + dy * 4, ex, ey, w);
}

function pointer(tx: number, ty: number, x: number, y: number, w: number): CalloutPlacement {
  return { x, y, edge: true, angle: Math.atan2(ty - y, tx - x), flip: x > w / 2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

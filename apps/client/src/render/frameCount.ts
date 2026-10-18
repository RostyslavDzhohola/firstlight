// The `?framecount` frame counters' logic (#23, D-e2e-2): one count per drawn frame, shown as a red
// marker cell and FRAME_BITS cells (most significant first, lit = 1) in the bottom-left corner of the
// WebGL frame, and the same cells plus the decimal count in the top-most DOM layer beside it. In a
// screen recording each frame then shows which layers are fresh: both counters advanced means a fresh
// frame; a counter that is missing or behind names the layer that dropped or went stale.
//
// Pure (no DOM, no three): render/frameCounter.ts draws it; the e2e journey decodes it.

/** Bits shown: the count modulo 2^20 (about 4.8 h at 60 fps before it wraps). */
export const FRAME_BITS = 20;
/** The strip: one cell of plate round a row of the marker and FRAME_BITS bits. */
export const STRIP_CELLS = FRAME_BITS + 3;
export const STRIP_ROWS = 3;

/** Counts drawn frames. */
export class FrameCount {
  value = 0;

  /** One more frame drawn: its number (1 for the first). */
  drawn(): number {
    return ++this.value;
  }
}

/** The bits of `n` (mod 2^FRAME_BITS), most significant first. */
export function frameBits(n: number): boolean[] {
  const v = ((Math.floor(n) % 2 ** FRAME_BITS) + 2 ** FRAME_BITS) % 2 ** FRAME_BITS;
  const out: boolean[] = [];
  for (let i = FRAME_BITS - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** i) % 2 === 1);
  return out;
}

/** The number the cells show (bits, most significant first). */
export function fromBits(bits: readonly boolean[]): number {
  return bits.reduce((v, b) => v * 2 + (b ? 1 : 0), 0);
}

/**
 * Where the WebGL strip sits in a drawing buffer `h` px high (origin top-left, y down): the cell size
 * scales with the height (about 1/96 of it, at least 3 px), one cell in from the left and the bottom.
 */
export function stripLayout(h: number): { cell: number; left: number; top: number; width: number; height: number } {
  const cell = Math.max(3, Math.floor(h / 96));
  return { cell, left: cell, top: h - cell - STRIP_ROWS * cell, width: STRIP_CELLS * cell, height: STRIP_ROWS * cell };
}

/** Centre (buffer px) of bit `i` (0 = most significant) or of the marker, for reading a frame back. */
export function cellCentre(h: number, i: number | "marker"): [number, number] {
  const L = stripLayout(h);
  const k = i === "marker" ? 1 : i + 2;
  return [L.left + (k + 0.5) * L.cell, L.top + 1.5 * L.cell];
}

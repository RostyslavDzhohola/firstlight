// `?framecount` (#23, D-e2e-2): the frame counters drawn into the presented frame and into the top-most
// DOM layer (render/frameCount.ts has the logic and the layout). The WebGL counter is the last step of
// the post pipeline's output (after FXAA), so it is in exactly the pixels the canvas presents, untouched
// by bloom, grading or the vignette. Its count moves on just before each frame is drawn
// (frameCounterTick in RenderCtx.render), which writes the DOM counter too, so both show one frame's
// number.
//
// Without the flag nothing here is created: withFrameCounter() hands the output node back as it is.

import * as THREE from "three/webgpu";
import { exp2, float, floor, mod, renderGroup, screenCoordinate, screenSize, select, uniform, vec3, vec4 } from "three/tsl";
import { flags } from "../config.ts";
import { FRAME_BITS, FrameCount, frameBits, STRIP_CELLS, STRIP_ROWS } from "./frameCount.ts";

type Counter = ReturnType<typeof makeCounter>;
let counter: Counter | null = null;

/** Is the counter on (`?framecount`)? */
export function frameCounterOn(): boolean {
  return flags.has("framecount");
}

/** What exists of the counter (tests: nothing at all without the flag). */
export function frameCounterState(): { count: number; dom: boolean } | null {
  return counter ? { count: counter.count.value, dom: !!counter.dom } : null;
}

/** `out` (the post pipeline's output) with the WebGL counter on top: only with `?framecount`. */
export function withFrameCounter(out: THREE.Node): THREE.Node {
  if (!frameCounterOn()) return out;
  const c = (counter ??= makeCounter());
  return overlay(out, c.value);
}

function makeCounter() {
  const count = new FrameCount();
  const dom = typeof document !== "undefined" ? new FrameCountDom() : null;
  // A render-group uniform written before each drawn frame (frameCounterTick), like the occluder
  // fade's: counted inside the output's own node update instead, every other frame's pixels showed
  // the number from two frames before (the e2e journey read 103, 102, 105, 104…).
  const value = uniform(0).setGroup(renderGroup);
  return { count, value, dom };
}

/** One more frame is about to be drawn (RenderCtx.render): both counters take its number. No-op without the flag. */
export function frameCounterTick(): void {
  if (!counter) return;
  const n = counter.count.drawn();
  counter.value.value = n % 2 ** FRAME_BITS;
  counter.dom?.show(n);
}

/** The strip (stripLayout) over `out`: plate black, the marker red, a 1 bit white, a 0 bit dark grey. */
function overlay(out: THREE.Node, value: Counter["value"]): THREE.Node {
  const o = out as unknown as ReturnType<typeof vec4>;
  const h = screenSize.y;
  const cell = floor(h.div(96)).max(3);
  const px = screenCoordinate.xy;
  // Cell column from the strip's left edge, cell row from its bottom edge (one cell in from each).
  const cx = floor(px.x.sub(cell).div(cell));
  const cy = floor(h.sub(cell).sub(px.y).div(cell));
  const inPlate = cx.greaterThanEqual(0).and(cx.lessThan(STRIP_CELLS)).and(cy.greaterThanEqual(0)).and(cy.lessThan(STRIP_ROWS));
  const inRow = cy.equal(1).and(cx.greaterThanEqual(1)).and(cx.lessThanEqual(FRAME_BITS + 1));
  const bit = mod(floor(value.div(exp2(float(FRAME_BITS + 1).sub(cx)))), 2); // cx 2 → the top bit
  const lit = select(cx.equal(1), vec3(1, 0, 0), select(bit.greaterThan(0.5), vec3(1, 1, 1), vec3(0.25, 0.25, 0.25)));
  const rgb = select(inRow, lit, vec3(0, 0, 0));
  return select(inPlate, vec4(rgb, 1), o) as unknown as THREE.Node;
}

/** The DOM counter: the same cells and the number, above every overlay (pause menu, perf, loader). */
class FrameCountDom {
  readonly root = document.createElement("div");
  private readonly bits: HTMLSpanElement[] = [];
  private readonly num = document.createElement("span");
  private last: boolean[] = [];

  constructor() {
    const r = this.root;
    r.className = "fl-framecount";
    r.dataset.e2e = "framecount";
    r.setAttribute("aria-hidden", "true");
    // Inline: no stylesheet to load, and a z-index no game layer comes near (they top out at 999).
    const cellCss = "calc(100vh / 96)";
    r.style.cssText = [
      "position:fixed",
      `left:calc(${STRIP_CELLS + 2} * ${cellCss})`,
      `bottom:${cellCss}`,
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      `height:calc(${STRIP_ROWS} * ${cellCss})`,
      `padding:0 ${cellCss}`,
      "background:#000",
      "pointer-events:none",
      `font:700 calc(2 * ${cellCss})/1 ui-monospace,monospace`,
      "color:#fff",
    ].join(";");
    const cell = (bg: string) => {
      const s = document.createElement("span");
      s.style.cssText = `display:block;flex:none;width:${cellCss};height:${cellCss};background:${bg}`;
      r.appendChild(s);
      return s;
    };
    cell("#f00");
    for (let i = 0; i < FRAME_BITS; i++) this.bits.push(cell("#404040"));
    this.num.style.cssText = `margin-left:${cellCss};flex:none`;
    r.appendChild(this.num);
    (document.body ?? document.documentElement).appendChild(r);
  }

  show(n: number) {
    const b = frameBits(n);
    for (let i = 0; i < b.length; i++) {
      if (b[i] === this.last[i]) continue;
      this.bits[i]!.style.background = b[i] ? "#fff" : "#404040";
    }
    this.last = b;
    this.num.textContent = String(n);
  }
}

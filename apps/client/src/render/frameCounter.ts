// `?framecount` (#23, D-e2e-2): the frame counters drawn into the presented frame and into the top-most
// DOM layer (render/frameCount.ts has the logic and the layout). Each frame's number is taken just
// before the frame is drawn (frameCounterTick in RenderCtx.render), which writes the DOM counter.
//
// On WebGL2 the canvas counter is a dozen scissored clears straight into the canvas right after the
// post pipeline has drawn (frameCounterDraw): in exactly the pixels the canvas presents, untouched by
// bloom, grading or the vignette, and with no shader or uniform in the way. Drawn as the last step
// of the post output instead (a TSL overlay reading a uniform), every other frame's pixels showed the
// number from two frames before, on readPixels and in screenshots alike (the e2e journey read 103,
// 102, 105, 104… against the DOM's 103, 104, 105, 106), whether the uniform was written in its own
// node update or before the render. On WebGPU the overlay is what draws it.
//
// Without the flag nothing here is created: withFrameCounter() hands the output node back as it is,
// and the tick and the draw return at once.

import * as THREE from "three/webgpu";
import { exp2, float, floor, mod, renderGroup, screenCoordinate, screenSize, select, uniform, vec3, vec4 } from "three/tsl";
import { flags } from "../config.ts";
import { FRAME_BITS, FrameCount, frameBits, STRIP_CELLS, STRIP_ROWS, stripLayout } from "./frameCount.ts";

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

/**
 * `out` (the post pipeline's output) as the pipeline should draw it: with `?framecount` on WebGPU,
 * the counter on top; otherwise as it is (on WebGL2 frameCounterDraw draws it).
 */
export function withFrameCounter(out: THREE.Node, webgpu: boolean): THREE.Node {
  if (!frameCounterOn()) return out;
  const c = (counter ??= makeCounter());
  return webgpu ? overlay(out, c.value) : out;
}

function makeCounter() {
  const count = new FrameCount();
  const dom = typeof document !== "undefined" ? new FrameCountDom() : null;
  const value = uniform(0).setGroup(renderGroup);
  return { count, value, dom, last: 0 };
}

/** A frame is about to be drawn (RenderCtx.render): its number, for both counters. No-op without the flag. */
export function frameCounterTick(): void {
  if (!counter) return;
  const n = (counter.last = counter.count.drawn());
  counter.value.value = n % 2 ** FRAME_BITS;
  counter.dom?.show(n);
}

/** WebGL2 state the counter's clears touch, put back after them. */
interface GlLike {
  readonly SCISSOR_TEST: number;
  readonly SCISSOR_BOX: number;
  readonly COLOR_CLEAR_VALUE: number;
  readonly COLOR_WRITEMASK: number;
  readonly DRAW_FRAMEBUFFER: number;
  readonly DRAW_FRAMEBUFFER_BINDING: number;
  readonly COLOR_BUFFER_BIT: number;
  readonly drawingBufferHeight: number;
  isEnabled(cap: number): boolean;
  enable(cap: number): void;
  disable(cap: number): void;
  getParameter(p: number): unknown;
  bindFramebuffer(target: number, fb: unknown): void;
  scissor(x: number, y: number, w: number, h: number): void;
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(mask: number): void;
}

/**
 * Right after the frame is drawn (RenderCtx.render), on WebGL2: the strip into the canvas with
 * scissored clears (stripLayout: plate black, marker red, a 1 bit white, a 0 bit dark grey). The GL
 * state it changes is put back, so three's own state cache stays true.
 */
export function frameCounterDraw(renderer: THREE.WebGPURenderer): void {
  if (!counter) return;
  const gl = (renderer.backend as unknown as { gl?: GlLike }).gl;
  if (!gl) return;
  const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
  const box = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
  const clear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
  const mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
  const fb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.enable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  const h = gl.drawingBufferHeight;
  const L = stripLayout(h);
  const fill = (x: number, yTop: number, w: number, hh: number, r: number, g: number, b: number) => {
    gl.scissor(x, h - yTop - hh, w, hh); // GL counts y from the bottom
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  fill(L.left, L.top, L.width, L.height, 0, 0, 0);
  const row = L.top + L.cell;
  fill(L.left + L.cell, row, L.cell, L.cell, 1, 0, 0);
  const bits = frameBits(counter.last);
  for (let i = 0; i < FRAME_BITS; i++) {
    const v = bits[i] ? 1 : 0.25;
    fill(L.left + (i + 2) * L.cell, row, L.cell, L.cell, v, v, v);
  }
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  gl.scissor(box[0]!, box[1]!, box[2]!, box[3]!);
  if (!scissorOn) gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(clear[0]!, clear[1]!, clear[2]!, clear[3]!);
  gl.colorMask(mask[0]!, mask[1]!, mask[2]!, mask[3]!);
}

/** The strip (stripLayout) over `out`: plate black, the marker red, a 1 bit white, a 0 bit dark grey. */
function overlay(out: THREE.Node, value: Counter["value"]): THREE.Node {
  const o = out as unknown as ReturnType<typeof vec4>;
  const h = screenSize.y;
  const cell = floor(h.div(96)).max(3);
  const px = screenCoordinate.xy;
  // Cell column from the strip's left edge (one cell in), cell row up from the bottom edge.
  const cx = floor(px.x.sub(cell).div(cell));
  const cy = floor(h.sub(px.y).div(cell));
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
      "bottom:0",
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

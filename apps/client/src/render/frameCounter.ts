// `?framecount` (#23, D-e2e-2): the frame counters drawn into the presented frame and into the top-most
// DOM layer (render/frameCount.ts has the logic and the layout). Each frame's number is taken just
// before the frame is drawn (frameCounterTick in RenderCtx.render), which writes the DOM counter; right
// after the post pipeline has drawn, frameCounterDraw puts the same number into the canvas: on WebGL2
// a dozen scissored clears into the default framebuffer, on WebGPU one scissored draw into the canvas
// texture. Either way in exactly the pixels the canvas presents, untouched by bloom, grading or the
// vignette, and outside three's node system: drawn as the post output's last step from a uniform, every
// other frame's pixels showed the number from two frames before (the e2e journey read 103, 102, 105,
// 104… against the DOM's 103, 104, 105, 106), whether the uniform was written in its node update or
// before the render, on WebGL2 (readPixels) and WebGPU (screenshots) alike.
//
// Without the flag nothing here is created: the tick and the draw return at once.

import type * as THREE from "three/webgpu";
import { flags } from "../config.ts";
import { FRAME_BITS, FrameCount, frameBits, stripLayout } from "./frameCount.ts";

interface Counter {
  count: FrameCount;
  dom: FrameCountDom | null;
  /** The number of the frame being drawn. */
  last: number;
  gpu: GpuStrip | null;
}
let counter: Counter | null = null;
let on: boolean | null = null;

/** Is the counter on (`?framecount`)? */
export function frameCounterOn(): boolean {
  return (on ??= flags.has("framecount"));
}

/** What exists of the counter (tests: nothing at all without the flag). */
export function frameCounterState(): { count: number; dom: boolean } | null {
  return counter ? { count: counter.count.value, dom: !!counter.dom } : null;
}

/** A frame is about to be drawn (RenderCtx.render): its number, for both counters. No-op without the flag. */
export function frameCounterTick(): void {
  if (!frameCounterOn()) return;
  const c = (counter ??= { count: new FrameCount(), dom: typeof document !== "undefined" ? new FrameCountDom() : null, last: 0, gpu: null });
  c.last = c.count.drawn();
  c.dom?.show(c.last);
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
 * Right after the frame is drawn (RenderCtx.render): the strip into the canvas (stripLayout: plate
 * black, marker red, a 1 bit white, a 0 bit dark grey). No-op without the flag.
 */
export function frameCounterDraw(renderer: THREE.WebGPURenderer): void {
  if (!counter) return;
  const backend = renderer.backend as unknown as { gl?: GlLike; device?: GPUDevice; context?: GPUCanvasContext };
  if (backend.gl) drawGl(backend.gl, counter.last);
  else if (backend.device && backend.context) (counter.gpu ??= new GpuStrip(backend.device)).draw(backend.context, counter.last);
}

/** Scissored clears into the default framebuffer; the GL state it changes is put back, so three's state cache stays true. */
function drawGl(gl: GlLike, n: number) {
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
  const bits = frameBits(n);
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

/** The strip in WGSL, drawn over the canvas texture (load, not clear) inside a scissor round it. */
const WGSL = /* wgsl */ `
struct U { n: u32, cell: f32, left: f32, top: f32 };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cx = i32(floor((pos.x - u.left) / u.cell));
  let cy = i32(floor((pos.y - u.top) / u.cell));
  if (cy != 1 || cx < 1 || cx > ${FRAME_BITS + 1}) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (cx == 1) { return vec4f(1.0, 0.0, 0.0, 1.0); }
  let bit = (u.n >> u32(${FRAME_BITS + 1} - cx)) & 1u;
  if (bit == 1u) { return vec4f(1.0, 1.0, 1.0, 1.0); }
  return vec4f(0.25, 0.25, 0.25, 1.0);
}`;

/** WebGPU: one scissored full-screen triangle into this frame's canvas texture, after three's own work. */
class GpuStrip {
  private readonly buffer: GPUBuffer;
  private readonly data = new ArrayBuffer(16);
  private pipeline: GPURenderPipeline | null = null;
  private format: GPUTextureFormat | null = null;
  private group: GPUBindGroup | null = null;

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({ size: 16, usage: 0x40 | 0x08 }); // GPUBufferUsage.UNIFORM | COPY_DST
  }

  draw(context: GPUCanvasContext, n: number) {
    const tex = context.getCurrentTexture(); // the texture three drew this frame into
    if (tex.format !== this.format) {
      const module = this.device.createShaderModule({ code: WGSL });
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: tex.format }] },
        primitive: { topology: "triangle-list" },
      });
      this.group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
      this.format = tex.format;
    }
    const L = stripLayout(tex.height);
    new Uint32Array(this.data, 0, 1)[0] = n % 2 ** FRAME_BITS;
    new Float32Array(this.data, 4, 3).set([L.cell, L.left, L.top]);
    this.device.queue.writeBuffer(this.buffer, 0, this.data);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    pass.setScissorRect(L.left, L.top, Math.min(L.width, tex.width - L.left), Math.min(L.height, tex.height - L.top));
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
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
    // Its stylesheet comes with the flag only; shown once it's in.
    r.hidden = true;
    void import("./frameCounter.css").then(() => (r.hidden = false));
    const cell = (cls: string) => {
      const s = document.createElement("span");
      s.className = cls;
      r.appendChild(s);
      return s;
    };
    cell("fl-framecount__cell fl-framecount__cell--mark");
    for (let i = 0; i < FRAME_BITS; i++) this.bits.push(cell("fl-framecount__cell"));
    this.num.className = "fl-framecount__num";
    r.appendChild(this.num);
    (document.body ?? document.documentElement).appendChild(r);
  }

  show(n: number) {
    const b = frameBits(n);
    for (let i = 0; i < b.length; i++) if (b[i] !== this.last[i]) this.bits[i]!.classList.toggle("is-on", b[i]);
    this.last = b;
    this.num.textContent = String(n);
  }
}

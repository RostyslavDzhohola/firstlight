// F3 performance overlay and the frame-time recorder used by ?bench.

import type { RenderCtx } from "./renderer.ts";

export class PerfOverlay {
  private readonly el: HTMLDivElement;
  private visible: boolean;
  private frames: number[] = [];
  private lastUpdate = 0;
  /** Frame times (ms) recorded while benchmarking. */
  recording: number[] | null = null;

  constructor(private readonly ctx: RenderCtx) {
    this.el = document.createElement("div");
    this.el.style.cssText =
      "position:fixed;top:8px;left:8px;z-index:50;font:12px/1.35 ui-monospace,monospace;color:#cfe;background:#0009;padding:6px 8px;border-radius:6px;white-space:pre;pointer-events:none";
    this.visible = new URLSearchParams(location.search).has("perf");
    this.el.style.display = this.visible ? "block" : "none";
    document.body.appendChild(this.el);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? "block" : "none";
  }

  frame(now: number, dt: number) {
    const ms = dt * 1000;
    this.frames.push(ms);
    if (this.frames.length > 120) this.frames.shift();
    this.recording?.push(ms);
    if (!this.visible || now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const info = this.ctx.renderer.info;
    this.el.textContent =
      `${(1000 / Math.max(1, p50)).toFixed(0)} fps  p50 ${p50.toFixed(1)} ms  p95 ${p95.toFixed(1)} ms\n` +
      `${this.ctx.webgpu ? "WebGPU" : "WebGL2"}  tier ${this.ctx.tier}\n` +
      `draws ${info.render.drawCalls}  tris ${(info.render.triangles / 1000).toFixed(0)}k`;
  }
}

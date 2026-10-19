// F3 performance overlay (SPEC §7.3): fps, CPU/GPU ms, draw calls, triangles, backend, tier, scale,
// chunk/grass/prop/particle/entity counts, ping, shader builds. Below the stats, the graphics panel:
// tier (auto/low/medium/high/ultra), render scale, every feature toggle (kill switches show as
// locked), re-probe and reset. Press Esc to free the mouse before clicking. ?perf or ?gfx opens it.

import { FEATURES, TIERS, type Feature, type RenderCtx, type Tier } from "./renderer.ts";
import { killSwitches } from "./quality.ts";
import { percentile } from "./timing.ts";
import { shaderStats } from "./warmup.ts";

export interface PerfExtras {
  cpuMs?: number;
  chunks?: number;
  visibleChunks?: number;
  water?: number;
  grass?: number;
  props?: number;
  particles?: number;
  entities?: number;
  ping?: number;
  body?: string;
}

export interface GfxActions {
  setTier(t: Tier | "auto"): void;
  setFeature(f: Feature, on: boolean | null): void;
  setScale(s: number | null): void;
  reprobe(): void;
  reset(): void;
}

const SCALES = [0.5, 0.67, 0.75, 0.85, 1, 1.25, 1.5];

export class PerfOverlay {
  private readonly root: HTMLDivElement;
  private readonly statsEl: HTMLPreElement;
  private readonly panel: HTMLDivElement;
  private visible: boolean;
  private readonly frames: number[] = [];
  private readonly cpu: number[] = [];
  private lastUpdate = 0;
  private lastPanelKey = "";
  /** Frame times (ms) recorded while benchmarking (legacy hook). */
  recording: number[] | null = null;
  actions: GfxActions | null = null;

  constructor(private readonly ctx: RenderCtx) {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;top:8px;left:8px;z-index:50;font:12px/1.35 ui-monospace,monospace;color:#cfe;background:#000a;padding:6px 8px;border-radius:6px;max-height:92vh;overflow:auto";
    this.statsEl = document.createElement("pre");
    this.statsEl.style.cssText = "margin:0;white-space:pre;pointer-events:none";
    this.panel = document.createElement("div");
    this.panel.style.cssText = "margin-top:6px;border-top:1px solid #fff2;padding-top:6px;display:grid;grid-template-columns:repeat(3,auto);gap:2px 10px";
    this.root.append(this.statsEl, this.panel);
    const q = new URLSearchParams(location.search);
    this.visible = q.has("perf") || q.has("gfx");
    this.root.style.display = this.visible ? "block" : "none";
    document.body.appendChild(this.root);
    // Keep clicks on the panel from reaching the canvas (which would grab pointer lock).
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    ctx.onChange(() => (this.lastPanelKey = ""));
  }

  toggle() {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? "block" : "none";
    this.lastPanelKey = "";
  }

  /** Is the overlay on screen (the extras passed to frame() are only read then)? */
  get shown(): boolean {
    return this.visible;
  }

  frame(now: number, dtSeconds: number, extras: PerfExtras = {}) {
    const ms = dtSeconds * 1000;
    this.frames.push(ms);
    if (this.frames.length > 120) this.frames.shift();
    if (extras.cpuMs !== undefined) {
      this.cpu.push(extras.cpuMs);
      if (this.cpu.length > 120) this.cpu.shift();
    }
    this.recording?.push(ms);
    if (!this.visible || now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const p50 = percentile(this.frames, 0.5);
    const p95 = percentile(this.frames, 0.95);
    const cpu = this.cpu.length ? percentile(this.cpu, 0.5) : 0;
    const gpu = this.ctx.gpu.busyP50() ?? this.ctx.gpu.p50(); // WebGPU: busy time (D-framerate-2)
    const info = this.ctx.renderer.info;
    const s = this.ctx.settings;
    const c = this.ctx.renderer.domElement;
    const sh = shaderStats();
    const fmt = (v: number | undefined) => (v === undefined ? "–" : v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(v));
    this.statsEl.textContent =
      `${(1000 / Math.max(1, p50)).toFixed(0)} fps  p50 ${p50.toFixed(1)}  p95 ${p95.toFixed(1)} ms  cpu ${cpu.toFixed(1)}  gpu ${gpu === null ? "n/a" : gpu.toFixed(1)} ms\n` +
      `${this.ctx.webgpu ? "WebGPU" : "WebGL2"}  tier ${s.tier}${s.auto ? " (auto)" : ""}${s.extras.length ? ` +${s.extras.join("+")}` : ""}  scale ${this.ctx.pixelRatio().toFixed(2)} (ladder ${this.ctx.ladder.scale})  ${c.width}×${c.height}\n` +
      `draws ${info.render.drawCalls}/${s.drawBudget}  tris ${(info.render.triangles / 1000).toFixed(0)}k  shaders ${sh.total}${sh.watching > 0 ? ` (+${sh.afterWarmup} since warm-up)` : ""}\n` +
      `chunks ${fmt(extras.visibleChunks)}/${fmt(extras.chunks)}  water ${fmt(extras.water)}  grass ${fmt(extras.grass)}  props ${fmt(extras.props)}  particles ${fmt(extras.particles)}\n` +
      `entities ${fmt(extras.entities)}  ping ${extras.ping ? extras.ping.toFixed(0) + " ms" : "–"}  ${extras.body ?? ""}  ${this.ctx.gpuName.slice(0, 48)}`;
    this.renderPanel();
  }

  private renderPanel() {
    const s = this.ctx.settings;
    const stored = this.ctx.stored();
    const key = JSON.stringify([s.tier, s.auto, s.on, stored.renderScale, !!this.actions]);
    if (key === this.lastPanelKey) return;
    this.lastPanelKey = key;
    const a = this.actions;
    this.panel.replaceChildren();
    if (!a) return;
    const kills = killSwitches();
    const tierSel = document.createElement("select");
    for (const t of ["auto", ...TIERS]) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t === "auto" ? `auto (${stored.autoTier ?? "probe"})` : t;
      tierSel.appendChild(o);
    }
    tierSel.value = stored.tier ?? "auto";
    tierSel.onchange = () => a.setTier(tierSel.value as Tier | "auto");
    const scaleSel = document.createElement("select");
    for (const v of ["tier", ...SCALES.map(String)]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v === "tier" ? `scale: tier (${s.renderScale})` : `scale ${v}`;
      scaleSel.appendChild(o);
    }
    scaleSel.value = stored.renderScale === null ? "tier" : String(stored.renderScale);
    scaleSel.onchange = () => a.setScale(scaleSel.value === "tier" ? null : Number(scaleSel.value));
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "font:inherit;cursor:pointer";
      b.onclick = fn;
      return b;
    };
    this.panel.append(tierSel, scaleSel, btn("re-probe", () => a.reprobe()));
    for (const f of FEATURES) {
      const label = document.createElement("label");
      label.style.cssText = "cursor:pointer;user-select:none";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = s.on[f];
      cb.disabled = kills.has(f);
      cb.onchange = () => a.setFeature(f, cb.checked);
      label.append(cb, ` ${f}${kills.has(f) ? " (url)" : ""}`);
      this.panel.appendChild(label);
    }
    this.panel.append(btn("reset gfx", () => a.reset()));
  }
}

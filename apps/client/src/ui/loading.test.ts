// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_STEPS, loadingPhase, rendererNote, stepProgress, WARMUP_FROM, WEBGL2_FALLBACK_LINE, WEBGPU_SLOW_LINE, warmupProgress, type LoadingPhase } from "./loading.ts";
import type * as LoadingT from "./loading.ts";
import { QUIP_MS, QUIPS, reportsTrouble } from "./loadingQuips.ts";

describe("loadingPhase", () => {
  it("maps Game.ts status lines to the four boot steps in order", () => {
    let p: LoadingPhase | undefined;
    const seen: number[] = [];
    for (const line of ["Loading the game…", "Starting the renderer…", "Travelling to Arcadia…", "Connecting…", "Building the world…", "Loading characters…", "Tuning graphics for this computer…", "Warming up shaders…"]) {
      p = loadingPhase(line, p);
      seen.push(p.step);
      expect(p.compact).toBe(false);
    }
    expect(seen).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(p!.body).toBe("arcadia");
  });

  it("uses the compact card for mid-game re-warms and reconnects", () => {
    const g = loadingPhase("Applying graphics settings…");
    expect(g).toMatchObject({ step: 3, compact: true });
    const r = loadingPhase("Reconnecting… (try 3)", { step: 3, body: "portus", compact: false });
    expect(r).toEqual({ step: 1, body: "portus", compact: true });
  });

  it("keeps the previous state for unknown lines and unknown bodies", () => {
    const prev: LoadingPhase = { step: 2, body: "meridian", compact: false };
    expect(loadingPhase("Something else", prev)).toBe(prev);
    expect(loadingPhase("Travelling to Nowhere…", prev).body).toBe("meridian");
  });
});

describe("the Renderer step while WebGPU starts (D-showcase-1)", () => {
  it("keeps the slow-start and fallback lines on the Renderer step of the full screen", () => {
    for (const line of [WEBGPU_SLOW_LINE, WEBGL2_FALLBACK_LINE]) {
      expect(loadingPhase(line, { step: 0, body: null, compact: false }), line).toEqual({ step: 0, body: null, compact: false });
    }
  });

  it("says in plain words that WebGPU is still starting and WebGL2 is the backup, never like an error", () => {
    expect(rendererNote("Starting the renderer…")).toBe(BOOT_STEPS[0].note);
    expect(WEBGPU_SLOW_LINE).toMatch(/still starting WebGPU/i);
    expect(rendererNote(WEBGPU_SLOW_LINE)).toMatch(/faster.*WebGL2 is the backup/);
    expect(rendererNote(WEBGL2_FALLBACK_LINE)).toMatch(/WebGL2.*backup/);
    for (const t of [WEBGPU_SLOW_LINE, WEBGL2_FALLBACK_LINE, rendererNote(WEBGPU_SLOW_LINE), rendererNote(WEBGL2_FALLBACK_LINE)]) {
      expect(t, t).not.toMatch(/error|fail|crash|broke|wrong|stuck|retry|timeout|timed out|slow/i);
      expect(reportsTrouble(t), t).toBe(false); // the quips keep running under it
    }
  });
});

describe("warm-up progress (Preparing shaders ready/total)", () => {
  it("labels GPU programs ready of those known, and moves the bar monotonically from the step's start to 100%", () => {
    const p = warmupProgress();
    expect(p.start()).toEqual({ text: "Preparing shaders…", frac: WARMUP_FROM });
    let prev = WARMUP_FROM;
    const seen = new Set<number>();
    // programs turn up as the compile goes (the total grows), and finish later
    for (let i = 1; i <= 100; i++) {
      const programs = Math.min(242, 40 + i * 3);
      const ready = Math.max(0, Math.floor(i * 2.42) - 20);
      const s = p.update({ ready, programs, frac: i / 100 });
      expect(s.text).toBe(ready > 0 || programs > 0 ? `Preparing shaders ${Math.min(ready, programs)}/${programs}` : "Preparing shaders…");
      expect(s.frac).toBeGreaterThanOrEqual(prev);
      prev = s.frac;
      seen.add(Math.round(s.frac * 100));
    }
    expect(prev).toBe(1);
    expect(seen.size).toBeGreaterThan(10); // the percentage keeps moving
  });

  it("never goes backwards, never shows more ready than known, and says nothing before the first program", () => {
    const p = warmupProgress();
    expect(p.update({ ready: 0, programs: 0, frac: 0.1 }).text).toBe("Preparing shaders…");
    const a = p.update({ ready: 90, programs: 100, frac: 0.6 });
    const b = p.update({ ready: 91, programs: 140, frac: 0.55 }); // a caller's blip: held
    expect(b.frac).toBe(a.frac);
    expect(p.update({ ready: 150, programs: 140, frac: 1 })).toEqual({ text: "Preparing shaders 140/140", frac: 1 });
  });

  it("fills only its own range (after the probe; a mid-game re-warm from 50%)", () => {
    const after = warmupProgress(0.9);
    expect(after.start().frac).toBe(0.9);
    expect(after.update({ ready: 1, programs: 2, frac: 0.5 }).frac).toBeCloseTo(0.95);
    const mid = warmupProgress(0.5);
    expect(mid.update({ ready: 2, programs: 2, frac: 1 }).frac).toBe(1);
  });

  it("is the warm-up boot step", () => {
    expect(loadingPhase("Preparing shaders…")).toMatchObject({ step: 3, compact: false });
    expect(loadingPhase("Preparing shaders 120/242", { step: 2, body: "portus", compact: false })).toEqual({ step: 3, body: "portus", compact: false });
    // a mid-game re-warm stays on the compact card
    expect(loadingPhase("Preparing shaders 3/9", { step: 3, body: "portus", compact: true }).compact).toBe(true);
  });
});

describe("stepProgress (a boot step's share of the bar, e.g. the first-visit probe)", () => {
  it("maps 0–1 into its range, monotonic", () => {
    const p = stepProgress(0.82, 0.9);
    expect(p.at(0)).toBeCloseTo(0.82);
    expect(p.at(0.5)).toBeCloseTo(0.86);
    expect(p.at(0.25)).toBeCloseTo(0.86); // never back
    expect(p.at(2)).toBeCloseTo(0.9);
  });
});

describe("the loader's rotating quips (D-load-5)", () => {
  // Each case is a fresh page: a new loader module over an empty document.
  let hideLoading: typeof LoadingT.hideLoading;
  let setLoading: typeof LoadingT.setLoading;
  let showLoadingError: typeof LoadingT.showLoadingError;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.replaceChildren();
    ({ hideLoading, setLoading, showLoadingError } = await import("./loading.ts"));
  });
  afterEach(() => {
    hideLoading();
    vi.useRealTimers();
  });

  const quipEl = () => document.querySelector<HTMLElement>(".fl-loading__quip");
  /** The line on screen, or null when there is none (no quip element, or it is hidden). */
  const shown = () => {
    const q = quipEl();
    if (!q || q.hidden || q.closest("[hidden]")) return null;
    return q.querySelector(".is-on")?.textContent ?? null;
  };

  it("start with the full screen: one of the lines, kept out of the polite live region, never focusable", () => {
    setLoading("Loading the game…", 0);
    expect(QUIPS).toContain(shown());
    const root = document.querySelector(".fl-loading")!;
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.contains(quipEl())).toBe(true);
    expect(quipEl()!.closest('[aria-hidden="true"], [aria-live="off"]')).not.toBeNull();
    expect(quipEl()!.querySelector("[tabindex], button, a")).toBeNull();
    expect(quipEl()!.contains(document.activeElement)).toBe(false);
  });

  it("change every few seconds, whatever the progress does, and show every line once before any comes back", () => {
    setLoading("Loading the game…", 0);
    const seen = [shown()];
    vi.advanceTimersByTime(QUIP_MS / 2);
    setLoading("Connecting…", 0.3); // progress updates don't restart the clock or skip a line
    setLoading("Building the world…", 0.5);
    expect(shown()).toBe(seen[0]);
    vi.advanceTimersByTime(QUIP_MS / 2);
    seen.push(shown());
    vi.advanceTimersByTime(QUIP_MS);
    seen.push(shown());
    // in the world for a while, then a trip to another body: the deck carries on, no repeats
    hideLoading();
    vi.advanceTimersByTime(60_000);
    setLoading("Travelling to Meridian…", 0.1);
    seen.push(shown());
    for (let i = 4; i < QUIPS.length; i++) {
      vi.advanceTimersByTime(QUIP_MS);
      seen.push(shown());
    }
    expect([...seen].sort()).toEqual([...QUIPS].sort());
    vi.advanceTimersByTime(QUIP_MS);
    expect(shown()).not.toBe(seen.at(-1)); // the next shuffle doesn't open with the last line
    expect(QUIPS).toContain(shown());
  });

  it("stop when the screen hides, and come back with the next full load (travel between bodies)", () => {
    setLoading("Warming up shaders…", 0.9);
    hideLoading();
    expect(shown()).toBeNull();
    const line = quipEl()!.querySelector(".is-on")?.textContent;
    vi.advanceTimersByTime(QUIP_MS * 5);
    expect(quipEl()!.querySelector(".is-on")?.textContent).toBe(line);
    setLoading("Travelling to Hollowmere…", 0.1);
    const first = shown();
    expect(QUIPS).toContain(first);
    vi.advanceTimersByTime(QUIP_MS);
    expect(shown()).not.toBe(first);
  });

  it("are not on the compact mid-game card", () => {
    setLoading("Applying graphics settings…", 0.5);
    expect(shown()).toBeNull();
    hideLoading();
    // a full load that turns into a reconnect drops the line, and a travel brings it back
    setLoading("Building the world…", 0.6);
    expect(shown()).not.toBeNull();
    setLoading("Reconnecting… (try 1)", 0.6);
    expect(shown()).toBeNull();
    const line = quipEl()!.querySelector(".is-on")?.textContent;
    vi.advanceTimersByTime(QUIP_MS * 3);
    expect(quipEl()!.querySelector(".is-on")?.textContent).toBe(line);
    setLoading("Travelling to Arcadia…", 0.1);
    expect(QUIPS).toContain(shown());
  });

  it("hide on full-screen lines that report a problem, and come back on the next normal line", () => {
    setLoading("Building the world…", 0.5);
    expect(QUIPS).toContain(shown());
    setLoading("The server couldn't save just now. Rejoining shortly…", 0.1);
    expect(document.querySelector(".fl-loading")!.classList.contains("fl-loading--compact")).toBe(false); // still the full screen
    expect(shown()).toBeNull();
    const line = quipEl()!.querySelector(".is-on")?.textContent;
    vi.advanceTimersByTime(QUIP_MS * 3);
    expect(quipEl()!.querySelector(".is-on")?.textContent).toBe(line);
    setLoading("Connecting…", 0.3);
    const back = shown();
    expect(QUIPS).toContain(back);
    vi.advanceTimersByTime(QUIP_MS);
    expect(shown()).not.toBe(back);
    // straight from play, whatever the wording
    for (const t of ["The server couldn't save just now. Rejoining shortly…", "Connection lost. Rejoining…", "Disconnected from the server…", "Reconnecting… (try 2)"]) {
      hideLoading();
      setLoading(t, 0.1);
      expect(shown(), t).toBeNull();
    }
  });

  it("keep running while the Renderer step says WebGPU is still starting", () => {
    setLoading("Starting the renderer…", 0.05);
    const note = () => document.querySelectorAll(".fl-loading__step")[0]!.querySelector("small")!.textContent;
    expect(note()).toBe(BOOT_STEPS[0].note);
    setLoading(WEBGPU_SLOW_LINE, 0.05);
    expect(document.querySelector(".fl-loading__status")!.textContent).toBe(WEBGPU_SLOW_LINE);
    expect(note()).toBe(rendererNote(WEBGPU_SLOW_LINE));
    expect(document.querySelectorAll(".fl-loading__step")[0]!.classList.contains("is-now")).toBe(true);
    expect(QUIPS).toContain(shown());
    setLoading(WEBGL2_FALLBACK_LINE, 0.05);
    expect(note()).toBe(rendererNote(WEBGL2_FALLBACK_LINE));
    setLoading("Travelling to Portus…", 0.15);
    expect(note()).toBe(rendererNote(WEBGL2_FALLBACK_LINE)); // the Renderer step is done; its note says how
  });

  it("are not on the error state, which keeps the focus on Retry; Retry brings them back", () => {
    setLoading("Starting the renderer…", 0.05);
    const retry = vi.fn();
    showLoadingError({ title: "The renderer didn't start", text: "Try again.", action: "Retry", onAction: retry });
    expect(shown()).toBeNull();
    expect(document.activeElement?.textContent).toBe("Retry");
    const line = quipEl()!.querySelector(".is-on")?.textContent;
    vi.advanceTimersByTime(QUIP_MS * 3);
    expect(quipEl()!.querySelector(".is-on")?.textContent).toBe(line);
    expect(document.activeElement?.textContent).toBe("Retry");
    setLoading("Loading the game…", 0);
    const first = shown();
    expect(QUIPS).toContain(first);
    vi.advanceTimersByTime(QUIP_MS);
    expect(shown()).not.toBe(first);
  });
});

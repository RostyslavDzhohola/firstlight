import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFramePath, type Viewport } from "./frameSize.ts";
import { ResolutionLadder } from "./timing.ts";

/**
 * The render context's frame path as createRenderer builds it (createFramePath), with fakes for
 * three's renderer, the camera, the window's resize events and the GPU timer, and a real ladder.
 * `log` records size-setting calls and draws in order, with `end` closing each frame's task.
 */
function harness(start: Viewport = { width: 1280, height: 720, pixelRatio: 1 }) {
  const log: string[] = [];
  const view = { ...start };
  const ladder = new ResolutionLadder();
  const target = {
    setDrawingBufferSize(w: number, h: number, pr: number) {
      log.push(`size ${Math.floor(w * pr)}x${Math.floor(h * pr)}`);
    },
  };
  const camera = {
    aspect: 1,
    updates: 0,
    updateProjectionMatrix() {
      this.updates++;
    },
  };
  const win = new EventTarget();
  const path = createFramePath({
    target,
    camera,
    // renderer.ts: innerWidth × innerHeight at ctx.pixelRatio(), which includes the ladder's scale.
    viewport: () => ({ ...view, pixelRatio: view.pixelRatio * ladder.scale }),
    draw: () => log.push(`draw ${Math.floor(view.width * view.pixelRatio * ladder.scale)}`),
    ladder,
    gpu: { frame() {}, takeSamples: () => [] },
    targetMs: () => 12,
    events: win,
  });
  log.length = 0; // the size applied at creation, before anything was drawn
  const size = { request: () => path.resize(), draw: <T>(fn: () => T) => path.drawWith(fn) };
  const resizeWindow = (width: number, height: number) => {
    view.width = width;
    view.height = height;
    win.dispatchEvent(new Event("resize"));
  };
  const render = () => path.render();
  let t = 1000;
  /** One game frame (Game.frame): draw, then the frame's bookkeeping (GPU timer, ladder), then the end of its task. */
  const frame = (frameMs: number) => {
    t += frameMs;
    render();
    path.afterFrame(t, frameMs);
    log.push("end");
  };
  return { log, view, ladder, size, camera, resizeWindow, render, frame };
}

/** Size-setting calls that landed between a draw and the end of that frame's task. */
function sizedAfterDraw(log: readonly string[]): string[] {
  const bad: string[] = [];
  let drawn = false;
  for (const e of log) {
    if (e.startsWith("draw")) drawn = true;
    else if (e === "end") drawn = false;
    else if (drawn && e.startsWith("size")) bad.push(e);
  }
  return bad;
}

describe("drawing-buffer size owner (D-view-3)", () => {
  it("sizes the canvas at creation, before anything is drawn", () => {
    const log: string[] = [];
    const camera = { aspect: 1, updateProjectionMatrix() {} };
    createFramePath({
      target: { setDrawingBufferSize: (w, h, pr) => log.push(`size ${w * pr}x${h * pr}`) },
      camera,
      viewport: () => ({ width: 1280, height: 720, pixelRatio: 1 }),
      draw: () => log.push("draw"),
      ladder: new ResolutionLadder(),
      gpu: { frame() {}, takeSamples: () => [] },
      targetMs: () => 12,
      events: new EventTarget(),
    });
    expect(log).toEqual(["size 1280x720"]);
    expect(camera.aspect).toBeCloseTo(1280 / 720);
  });

  it("resizes for a ladder step only right before the next draw, never after a frame's draw", () => {
    const h = harness();
    // Slow frames walk the ladder down to its floor (three steps).
    for (let i = 0; i < 1200; i++) h.frame(28);
    const steps = h.log.filter((e) => e.startsWith("size")).length;
    expect(steps).toBe(3);
    expect(sizedAfterDraw(h.log)).toEqual([]);
    // Each step is applied by the draw that follows it, at the new size.
    for (let i = 0; i < h.log.length; i++) {
      if (h.log[i]!.startsWith("size")) expect(h.log[i + 1]).toMatch(/^draw/);
    }
    expect(h.log.filter((e) => e.startsWith("size"))).toEqual(["size 1011x568", "size 793x446", "size 640x360"]);
  });

  it("takes a window resize between frames at the next draw", () => {
    const h = harness();
    h.frame(16.7);
    h.resizeWindow(1100, 640);
    expect(h.log).toEqual(["draw 1280", "end"]); // the resize event touched nothing yet
    h.frame(16.7);
    expect(h.log.slice(2)).toEqual(["size 1100x640", "draw 1100", "end"]);
    expect(h.camera.aspect).toBeCloseTo(1100 / 640);
    expect(sizedAfterDraw(h.log)).toEqual([]);
  });

  it("coalesces several requests into one size-setting call", () => {
    const h = harness();
    h.frame(16.7);
    h.resizeWindow(1200, 700);
    h.resizeWindow(1100, 640);
    h.size.request();
    h.frame(16.7);
    expect(h.log.filter((e) => e.startsWith("size"))).toEqual(["size 1100x640"]);
  });

  it("makes no size-setting call when the physical size doesn't change", () => {
    const h = harness();
    h.frame(16.7);
    const updates = h.camera.updates;
    h.size.request(); // e.g. a settings change that keeps the pixel ratio
    h.frame(16.7);
    h.view.pixelRatio = 1.0004; // rounds to the same drawing buffer
    h.size.request();
    h.frame(16.7);
    expect(h.log.filter((e) => e.startsWith("size"))).toEqual([]);
    expect(h.camera.updates).toBe(updates); // same aspect: the projection stays
  });

  it("updates the camera aspect in the same step as the size", () => {
    const h = harness();
    h.render();
    const updates = h.camera.updates;
    h.resizeWindow(800, 800);
    expect(h.camera.aspect).toBeCloseTo(1280 / 720); // a request alone changes nothing
    h.render();
    expect(h.camera.aspect).toBe(1);
    expect(h.camera.updates).toBe(updates + 1);
  });

  it("applies a pending size before a manual draw too (warm-up, probe)", () => {
    const h = harness();
    h.render();
    h.resizeWindow(960, 540);
    // The warm-up's scene-pass probe draws through the same path (drawWith).
    h.size.draw(() => h.log.push("probe"));
    expect(h.log.slice(-2)).toEqual(["size 960x540", "probe"]);
  });

  it("waits while the window has no area (minimised) instead of sizing to zero", () => {
    const h = harness();
    h.render();
    h.resizeWindow(0, 0);
    h.render();
    h.resizeWindow(1280, 720);
    h.resizeWindow(1024, 600);
    h.render();
    expect(h.log.filter((e) => e.startsWith("size"))).toEqual(["size 1024x600"]);
  });

  it("is the only code that sets the canvas size (no other setSize / setPixelRatio / setDrawingBufferSize)", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".testutil.ts"));
    const hits = files.flatMap((f) =>
      readFileSync(join(src, f), "utf8")
        .split("\n")
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter((x) => /\.(setSize|setPixelRatio|setDrawingBufferSize)\(|domElement\.(width|height)\s*=[^=]/.test(x.line) && !x.line.trim().startsWith("//")),
    );
    const owner = join("render", "frameSize.ts");
    expect(hits.some((h) => h.f === owner), "the scan sees the owner's own call").toBe(true);
    expect(hits.filter((h) => h.f !== owner).map((h) => `${h.f}:${h.i}: ${h.line.trim()}`)).toEqual([]);
  });
});

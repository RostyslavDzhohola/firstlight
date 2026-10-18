// ?framecount (#23, D-e2e-2): a frame counter drawn into the WebGL frame and one in the top-most DOM
// layer. Read back from 40 consecutive drawn frames (readPixels in the same task as each render): both
// show the same number in every frame and advance by one per drawn frame; and in composited
// screenshots (what a recording sees) both decode to the same number. The DOM counter stays on top of
// the pause menu, the performance overlay and the loader. Without the flag there is no counter.

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { OUT } from "./stack.ts";
import { cellCentre, FRAME_BITS, fromBits } from "../src/render/frameCount.ts";

const SHOTS = process.env.STALL_SHOTS ?? path.join(OUT, "framecount");

/**
 * Decode both counters from one screenshot (PNG, CSS pixels): the WebGL strip where stripLayout puts
 * it (scaled from the drawing buffer to the page) and the DOM counter's cells where the page lays them out.
 */
async function readShot(page: Page, b64: string): Promise<{ gl: number; dom: number }> {
  return page.evaluate(
    async ([b64, bits]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(img.width, img.height).getContext("2d", { willReadFrequently: true })!;
      c.drawImage(img, 0, 0);
      const lit = (x: number, y: number) => {
        const d = c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        return d[0]! > 160 && d[1]! > 160 && d[2]! > 160;
      };
      const canvas = (window as unknown as { __game: { ctx: { renderer: { domElement: HTMLCanvasElement } } } }).__game.ctx.renderer.domElement;
      const k = img.height / canvas.height; // drawing-buffer px → screenshot px
      const cell = Math.max(3, Math.floor(canvas.height / 96));
      const top = canvas.height - 3 * cell; // stripLayout: on the bottom edge
      let gl = 0;
      for (let i = 0; i < bits; i++) gl = gl * 2 + (lit((cell + (i + 2.5) * cell) * k, (top + 1.5 * cell) * k) ? 1 : 0);
      const spans = [...document.querySelectorAll<HTMLElement>('[data-e2e="framecount"] span')].slice(1, 1 + bits);
      const sx = img.width / innerWidth;
      let dom = 0;
      for (const s of spans) {
        const r = s.getBoundingClientRect();
        dom = dom * 2 + (lit((r.left + r.width / 2) * sx, (r.top + r.height / 2) * sx) ? 1 : 0);
      }
      return { gl, dom };
    },
    [b64, FRAME_BITS] as const,
  );
}

interface Read {
  dom: number | null;
  /** RGBA at each cell centre: the marker, then the bits (most significant first). */
  cells: number[][];
  h: number;
}

test.describe("?framecount", () => {
  test("framecount · #23 · both counters show each drawn frame's number, the DOM one above every overlay", { tag: ["@framecount"] }, async ({ player, page }) => {
    mkdirSync(SHOTS, { recursive: true });
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia", extra: { framecount: true } });
    await player.waitInWorld(180_000, "arcadia");
    await player.lock();
    await expect(page.locator('[data-e2e="framecount"]'), "the DOM counter").toBeVisible();

    // WebGL2: 40 consecutive drawn frames, the canvas cells read back with readPixels in each render's
    // task (the drawing buffer as drawn) and the DOM number at that moment. (WebGPU: screenshots only.)
    if (player.gfx === "webgl") {
      const h0 = await page.evaluate(() => (window as unknown as { __game: { ctx: { renderer: { domElement: HTMLCanvasElement } } } }).__game.ctx.renderer.domElement.height);
      const pts = [cellCentre(h0, "marker"), ...Array.from({ length: FRAME_BITS }, (_, i) => cellCentre(h0, i))];
      const reads: Read[] = await page.evaluate(
        ([pts, n]) =>
          new Promise<Read[]>((resolve) => {
            const ctx = (window as unknown as { __game: { ctx: { render(): void; renderer: { domElement: HTMLCanvasElement; backend: { gl?: WebGL2RenderingContext } } } } }).__game.ctx;
            const canvas = ctx.renderer.domElement;
            const gl = ctx.renderer.backend.gl!;
            const original = ctx.render;
            const out: Read[] = [];
            const px = new Uint8Array(4);
            ctx.render = function () {
              original.call(ctx);
              const num = document.querySelector('[data-e2e="framecount"] span:last-child')?.textContent ?? null;
              const h = canvas.height;
              // The default framebuffer as this render left it; three's own binding is put back after.
              const fb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
              const cells = pts.map(([x, y]) => {
                gl.readPixels(Math.floor(x!), h - 1 - Math.floor(y!), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return [...px];
              });
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
              out.push({ dom: num === null ? null : Number(num), cells, h });
              if (out.length >= n) {
                ctx.render = original;
                resolve(out);
              }
            };
          }),
        [pts, 40] as const,
      );
      expect(reads.every((r) => r.h === h0), "the buffer kept its size while reading").toBe(true);
      const decode = (cells: number[][]) => {
        const [marker, ...bits] = cells;
        expect.soft(marker![0]! > 200 && marker![1]! < 60 && marker![2]! < 60, `the red marker cell (${marker})`).toBe(true);
        return fromBits(bits.map((p) => p[0]! > 160 && p[1]! > 160 && p[2]! > 160));
      };
      const gl = reads.map((r) => decode(r.cells));
      await player.note("framecount-frames", { gl: gl.slice(0, 8), dom: reads.slice(0, 8).map((r) => r.dom) });
      for (let i = 0; i < reads.length; i++) expect.soft(gl[i], `frame ${i}: the WebGL counter shows the DOM counter's number`).toBe(reads[i]!.dom! % 2 ** FRAME_BITS);
      for (let i = 1; i < gl.length; i++) expect.soft(gl[i]! - gl[i - 1]!, `frame ${i}: one more than the frame before`).toBe(1);
    }

    // What a recording sees: composited screenshots, both counters decoded from the same image.
    const shots: { gl: number; dom: number }[] = [];
    for (let k = 0; k < 8; k++) {
      const png = await page.screenshot({ path: k === 0 ? path.join(SHOTS, "framecount-play.png") : undefined });
      shots.push(await readShot(page, png.toString("base64")));
    }
    await player.note("framecount-shots", shots);
    for (const [k, x] of shots.entries()) expect.soft(x.gl, `screenshot ${k}: both counters show one frame's number`).toBe(x.dom);
    for (let k = 1; k < shots.length; k++) expect.soft(shots[k]!.gl, `screenshot ${k}: a later frame than the one before`).toBeGreaterThan(shots[k - 1]!.gl);

    // Above every overlay: the performance overlay and the pause menu open, then the loader shown.
    await player.tap("Backquote");
    await player.escape();
    await expect(page.locator('[data-e2e="pause-menu"]'), "the pause menu").toBeVisible();
    // Hit-testing finds the top-most element at a point; the counter ignores the mouse, so it is made
    // hit-testable for the moment of the check.
    const topmost = () =>
      page.evaluate(() => {
        const e = document.querySelector<HTMLElement>('[data-e2e="framecount"]')!;
        e.style.pointerEvents = "auto";
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width * 0.75, r.top + r.height / 2);
        e.style.pointerEvents = "none";
        return !!hit && e.contains(hit);
      });
    expect.soft(await topmost(), "the DOM counter over the pause menu and the performance overlay").toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, "framecount-pause-menu-perf.png") });
    const loaderOnTop = await page.evaluate(() => {
      const ld = document.getElementById("loading")!;
      const was = ld.hidden;
      ld.hidden = false;
      const e = document.querySelector<HTMLElement>('[data-e2e="framecount"]')!;
      e.style.pointerEvents = "auto";
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width * 0.75, r.top + r.height / 2);
      const ok = !!hit && e.contains(hit);
      e.style.pointerEvents = "none";
      ld.hidden = was;
      return ok;
    });
    expect.soft(loaderOnTop, "the DOM counter over the loader").toBe(true);
    await page.evaluate(() => (document.getElementById("loading")!.hidden = false));
    await page.screenshot({ path: path.join(SHOTS, "framecount-over-loader.png") });
    await page.evaluate(() => (document.getElementById("loading")!.hidden = true));
  });

  test("framecount · #23 · without the flag there is no counter", { tag: ["@framecount"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(180_000, "arcadia");
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-e2e="framecount"]')).toHaveCount(0);
  });
});

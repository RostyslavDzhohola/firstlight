// The one owner of the 3D canvas's drawing-buffer size (D-view-3). Assigning a canvas's width or height
// clears its drawing buffer, even to the same value. The resolution ladder used to resize from
// afterFrame, after the frame was drawn in the same animation frame: Chrome then presented the cleared
// canvas (alpha: the page background, #05070a) under an intact HUD, one blank world frame per step.
//
// Every size request (ladder step, window resize or fullscreen change, settings, tier, render scale)
// only records that the size is pending. A draw applies it first, then draws: the frame's own
// render, the warm-up and probe frames, and the warm-up's scene-pass probe all draw through draw().
// Applying is skipped when the physical size is unchanged; the camera aspect follows in the same step.
//
// Pure (no three, no DOM): renderer.ts passes three's renderer and the camera; tests pass fakes.

/** The part of three's Renderer that sets the size: logical size × pixel ratio, one canvas assignment. */
export interface SizeTarget {
  setDrawingBufferSize(width: number, height: number, pixelRatio: number): void;
}

export interface AspectCamera {
  aspect: number;
  updateProjectionMatrix(): void;
}

/** The size wanted now: CSS pixels of the window and the effective pixel ratio. */
export interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

export class FrameSize {
  private pending = true;
  /** Physical drawing-buffer size last applied (null: never). */
  private applied: { w: number; h: number } | null = null;

  constructor(
    private readonly target: SizeTarget,
    private readonly camera: AspectCamera,
    private readonly wanted: () => Viewport,
  ) {}

  /** Ask for the size to be re-read; it is applied right before the next draw. Never touches the canvas. */
  request(): void {
    this.pending = true;
  }

  /** Draw through the owner: the pending size first, then `fn`. */
  draw<T>(fn: () => T): T {
    this.apply();
    return fn();
  }

  /**
   * Apply a pending size now. Only right before drawing (draw() does it) or before anything was ever
   * drawn: applying after a draw in the same task clears that frame.
   */
  apply(): void {
    if (!this.pending) return;
    const { width, height, pixelRatio } = this.wanted();
    if (!(width > 0 && height > 0 && pixelRatio > 0)) return; // minimised: keep it pending
    this.pending = false;
    const aspect = width / height;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    if (this.applied && this.applied.w === w && this.applied.h === h) return;
    this.target.setDrawingBufferSize(width, height, pixelRatio);
    this.applied = { w, h };
  }
}

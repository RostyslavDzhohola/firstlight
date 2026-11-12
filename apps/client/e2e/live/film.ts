// Films a live session's page: Chrome's screencast (CDP Page.startScreencast, JPEG frames as the page
// paints) into the system ffmpeg on a fixed 25 fps clock, encoded by the Mac's hardware H.264 encoder.
// Lighter than Playwright's recorder (software VP9 on one thread, which ran a core flat out and fell
// minutes behind), and frame n is filmed at exactly start + n × 40 ms, so the strip lines up.

import type { Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

const FPS = 25;
/** Frames waiting for ffmpeg past this many bytes: it can't keep up, so the film ends there (still in step). */
const BACKLOG_BYTES = 256 * 1024 * 1024;
/** How long `stop` waits for ffmpeg to finish the file before asking it to quit, then killing it. */
const FINISH_MS = 5 * 60_000;
const ENCODER = process.platform === "darwin" ? ["-c:v", "h264_videotoolbox", "-b:v", "5M"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];

export class Film {
  /** Wall-clock ms of frame 0. */
  startedAt = 0;
  private ff: ChildProcess | null = null;
  private latest: Buffer | null = null;
  private written = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private stopCast: (() => Promise<void>) | null = null;
  private exited: Promise<number | null> = Promise.resolve(null);
  /** Why the film ended early (ffmpeg fell behind or died), if it did. */
  cut: string | null = null;

  constructor(private readonly page: Page, readonly file: string) {}

  async start() {
    const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0", ...ENCODER, "-pix_fmt", "yuv420p", "-vf", "scale=1280:720", this.file], { stdio: ["pipe", "ignore", "inherit"] });
    this.ff = ff;
    // A missing ffmpeg comes as `error` (no `exit`): settle on either, and fail the start cleanly.
    this.exited = new Promise((resolve) => {
      ff.once("error", (e) => {
        this.cut ??= `ffmpeg: ${e.message}`;
        resolve(null);
      });
      ff.once("close", (code) => resolve(code));
    });
    ff.stdin.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      ff.once("spawn", () => resolve());
      ff.once("error", reject);
    });
    const cdp = await this.page.context().newCDPSession(this.page);
    cdp.on("Page.screencastFrame", ({ data, sessionId }: { data: string; sessionId: number }) => {
      this.latest = Buffer.from(data, "base64");
      if (!this.startedAt) this.startedAt = Date.now(); // frame 0 is the first picture
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    // Every second painted frame (about 30 a second) is enough for a 25 fps film and halves the frames
    // this process has to take in next to the commands.
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
    this.stopCast = async () => {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    };
    // Keep the 25 fps clock: write the latest picture for every 40 ms that has passed (a still page
    // sends no frames, so its last one repeats).
    this.tick = setInterval(() => this.catchUp(), 20);
  }

  private catchUp() {
    if (!this.latest || !this.startedAt || this.cut || !this.ff?.stdin?.writable) return;
    // Every 40 ms slot must get a picture or the film drifts off the clock: when ffmpeg falls this far
    // behind, end the film here instead (what was filmed stays in step) rather than queue without end.
    if (this.ff.stdin.writableLength > BACKLOG_BYTES) {
      this.cut = `ffmpeg fell behind; the film stops at ${this.seconds.toFixed(0)} s`;
      this.ff.stdin.end();
      return;
    }
    const due = Math.floor(((Date.now() - this.startedAt) * FPS) / 1000);
    while (this.written < due) {
      this.ff.stdin.write(this.latest);
      this.written++;
    }
  }

  /** Seconds filmed so far. */
  get seconds() {
    return this.written / FPS;
  }

  /** Stop filming and wait (at most FINISH_MS, then SIGINT, which still writes the file, then SIGKILL) for the file. */
  async stop(): Promise<string> {
    clearInterval(this.tick);
    this.catchUp();
    await this.stopCast?.();
    this.ff?.stdin?.end();
    const within = (ms: number) => Promise.race([this.exited, new Promise<"late">((r) => setTimeout(() => r("late"), ms))]);
    let code = await within(FINISH_MS);
    if (code === "late") {
      this.cut ??= "ffmpeg took too long to finish the file";
      this.ff?.kill("SIGINT");
      code = await within(20_000);
      if (code === "late") this.ff?.kill("SIGKILL");
    }
    if (code !== 0) throw new Error(`the film failed: ${this.cut ?? `ffmpeg exited with ${code}`}`);
    return this.file;
  }
}

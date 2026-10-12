// Screenshot share (P / HUD button, SPEC §6.10, T7): render a frame and copy it off the canvas in
// the same task (works for WebGPU and WebGL2 canvases, no preserveDrawingBuffer needed), stamp a
// branded frame on a 2D canvas, then offer Copy image / Download / Share (Web Share with files) /
// Share on X. Nothing is uploaded.

import { el, sbtn } from "./dom.ts";

export const SITE = "firstlight.one4all.dev";
export const SITE_URL = `https://${SITE}`;
const MAX_WIDTH = 1920;

export interface ShotInfo {
  name: string;
  level: number;
  planet: string;
}

export interface ShotSource {
  canvas: HTMLCanvasElement;
  /** Draw one frame into the canvas right now. */
  render(): void;
}

/** Render, grab the canvas synchronously, and stamp the frame. Returns the PNG. */
export async function captureShot(src: ShotSource, info: ShotInfo): Promise<{ blob: Blob; blank: boolean }> {
  const c = src.canvas;
  const scale = Math.min(1, MAX_WIDTH / Math.max(1, c.width));
  const out = document.createElement("canvas");
  out.width = Math.max(2, Math.round(c.width * scale));
  out.height = Math.max(2, Math.round(c.height * scale));
  const g = out.getContext("2d")!;
  g.fillStyle = "#07060d";
  g.fillRect(0, 0, out.width, out.height);
  let blank = true;
  try {
    src.render();
    g.drawImage(c, 0, 0, out.width, out.height);
    blank = isBlank(g, out.width, out.height);
  } catch (err) {
    console.warn("screenshot capture failed", err);
  }
  if (blank) {
    // No pixels from the 3D canvas: still give the player a branded card.
    const grad = g.createRadialGradient(out.width / 2, out.height * 1.2, 0, out.width / 2, out.height * 1.2, out.height * 1.4);
    grad.addColorStop(0, "#2a1b4f");
    grad.addColorStop(0.55, "#0b0618");
    grad.addColorStop(1, "#050409");
    g.fillStyle = grad;
    g.fillRect(0, 0, out.width, out.height);
  }
  stamp(g, out.width, out.height, info);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  if (!blob) throw new Error("couldn't encode the screenshot");
  return { blob, blank };
}

function isBlank(g: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const pts = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.3, 0.75], [0.7, 0.75]];
    for (const [fx, fy] of pts) {
      const d = g.getImageData(Math.floor(w * fx!), Math.floor(h * fy!), 1, 1).data;
      if (d[0]! + d[1]! + d[2]! > 12) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The branded frame: a thin border, a bottom band with the wordmark, player, planet and the URL. */
export function stamp(g: CanvasRenderingContext2D, w: number, h: number, info: ShotInfo): void {
  const u = Math.max(0.6, Math.min(w, h * 1.78) / 1280); // unit scale
  const band = Math.round(92 * u);
  const pad = Math.round(28 * u);
  const fade = g.createLinearGradient(0, h - band * 1.6, 0, h);
  fade.addColorStop(0, "rgba(7,6,13,0)");
  fade.addColorStop(0.45, "rgba(7,6,13,0.55)");
  fade.addColorStop(1, "rgba(7,6,13,0.88)");
  g.fillStyle = fade;
  g.fillRect(0, h - band * 1.6, w, band * 1.6);

  // Frame.
  g.strokeStyle = "rgba(255,216,168,0.45)";
  g.lineWidth = Math.max(1, Math.round(2 * u));
  const inset = Math.round(10 * u);
  g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

  const font = (weight: number, px: number) => `${weight} ${Math.round(px * u)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const baseY = h - pad - Math.round(4 * u);

  // Wordmark.
  g.save();
  g.font = font(800, 34);
  try {
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${Math.round(7 * u)}px`;
  } catch {}
  const wordY = baseY - Math.round(30 * u);
  const wm = g.createLinearGradient(0, wordY - 30 * u, 0, wordY);
  wm.addColorStop(0, "#ffffff");
  wm.addColorStop(0.55, "#ffd8a8");
  wm.addColorStop(1, "#ff7edb");
  g.fillStyle = wm;
  g.shadowColor = "rgba(255,126,219,0.45)";
  g.shadowBlur = 18 * u;
  g.textBaseline = "alphabetic";
  g.fillText("FIRSTLIGHT", pad, wordY);
  g.restore();

  // Player line.
  g.font = font(600, 18);
  g.fillStyle = "#ece8f6";
  g.textBaseline = "alphabetic";
  const who = `${info.name}  ·  Level ${info.level}  ·  ${info.planet}`;
  g.fillText(who, pad, baseY);

  // URL, right-aligned.
  g.textAlign = "right";
  g.font = font(700, 20);
  g.fillStyle = "#ffd8a8";
  g.fillText(SITE, w - pad, baseY);
  g.font = font(500, 13);
  g.fillStyle = "#b9b2cc";
  g.fillText("Play free in your browser", w - pad, baseY - Math.round(26 * u));
  g.textAlign = "left";
}

export function shareText(info: ShotInfo): string {
  return `Level ${info.level} on ${info.planet} in FIRSTLIGHT, an open world in the browser. One life.`;
}

export function xIntentUrl(info: ShotInfo): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(shareText(info))}&url=${encodeURIComponent(SITE_URL)}`;
}

/** The share dialog. Resolves when closed. */
export function shareDialog(blob: Blob, info: ShotInfo, blank: boolean, onClose: () => void): void {
  const url = URL.createObjectURL(blob);
  const file = new File([blob], `firstlight-${info.planet.toLowerCase()}-${Date.now()}.png`, { type: "image/png" });
  const ov = el("div", "fl-overlay fl-shot");
  const p = el("div", "fl-panel", ov);
  el("h2", "", p, "SCREENSHOT").style.fontSize = "18px";
  const img = el("img", "", p);
  img.src = url;
  img.alt = `FIRSTLIGHT screenshot: ${info.name}, level ${info.level}, ${info.planet}`;
  const row = el("div", "row", p);
  const note = el("div", "note", p, blank ? "This browser didn't let us read the 3D view, so here's your card." : "Nothing is uploaded. The image stays on your computer until you share it.");
  const say = (t: string) => (note.textContent = t);

  const close = () => {
    ov.remove();
    URL.revokeObjectURL(url);
    document.removeEventListener("keydown", onKey, true);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    sbtn("Copy image", async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        say("Copied. Paste it anywhere.");
      } catch {
        say("Your browser blocked copying. Use Download instead.");
      }
    }, "primary", row);
  }
  sbtn("Download", () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    say("Saved to your downloads.");
  }, "", row);
  const canShareFiles = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  if (canShareFiles) {
    sbtn("Share…", async () => {
      try {
        await navigator.share({ files: [file], title: "FIRSTLIGHT", text: shareText(info), url: SITE_URL });
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") say("Sharing didn't work here. Try Copy or Download.");
      }
    }, "", row);
  }
  sbtn("Share on X", () => {
    window.open(xIntentUrl(info), "_blank", "noopener,noreferrer");
    say("Attach the image (Copy or Download) to your post.");
  }, "", row);
  sbtn("Close", close, "", row);
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) close();
  });
  document.body.appendChild(ov);
}

/** A quick white flash so the player sees the shot was taken. */
export function flash(): void {
  const f = el("div", "fl-shot-flash", document.body);
  requestAnimationFrame(() => {
    f.style.opacity = "0";
    setTimeout(() => f.remove(), 400);
  });
}

export const CAMERA_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

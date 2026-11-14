// The keypad egg's in-world clue as two textures (#41, review 2026-11-13 ship #4): the digits painted
// back to front on the wall of the mirror room, and the same digits as the mirror shows them. They are
// drawn here from the server's rule (apps/server/src/world/quests/eggRules.ts) into PNGs the client
// imports, so the answer is pixels in an image and never text in client code or the bundle.
// Our own art (CC BY 4.0, LICENSE-ART). Run after changing the rule:
//   node tools/eggs/mirror-clue.ts
// Pure Node: a stroke font for the ten digits, 4× supersampled coverage, PNG via node:zlib.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { EGG_RULES } from "../../apps/server/src/world/quests/eggRules.ts";

type Seg = [number, number, number, number];
// Strokes on a 4 × 7 cell (x right, y down): a stencilled, painted-by-hand look.
const A: Seg = [0, 0, 4, 0];
const B: Seg = [4, 0, 4, 3.5];
const C: Seg = [4, 3.5, 4, 7];
const D: Seg = [0, 7, 4, 7];
const E: Seg = [0, 3.5, 0, 7];
const F: Seg = [0, 0, 0, 3.5];
const G: Seg = [0, 3.5, 4, 3.5];
const GLYPHS: Record<string, Seg[]> = {
  "0": [A, B, C, D, E, F],
  "1": [[2, 0, 2, 7], [0.8, 1.2, 2, 0], [0.8, 7, 3.2, 7]],
  "2": [A, B, G, E, D],
  "3": [A, B, G, C, D],
  "4": [F, G, [3, 0, 3, 7]],
  "5": [A, F, G, C, D],
  "6": [A, F, G, E, C, D],
  "7": [A, [4, 0, 1.6, 7]],
  "8": [A, B, C, D, E, F, G],
  "9": [A, B, C, D, F, G],
};

const W = 512;
const H = 256;
const SS = 4;

function render(text: string, fg: [number, number, number], bg: [number, number, number], mirrored: boolean): Buffer {
  const glyphW = 4;
  const gap = 2;
  const total = text.length * glyphW + (text.length - 1) * gap;
  const unit = Math.min((W * 0.82) / total, (H * 0.62) / 7);
  const ox = (W - total * unit) / 2;
  const oy = (H - 7 * unit) / 2;
  const half = 0.42 * unit;
  const segs: Seg[] = [];
  [...text].forEach((ch, i) => {
    for (const [x1, y1, x2, y2] of GLYPHS[ch] ?? []) {
      const dx = ox + i * (glyphW + gap) * unit;
      segs.push([dx + x1 * unit, oy + y1 * unit, dx + x2 * unit, oy + y2 * unit]);
    }
  });
  const dist = (px: number, py: number) => {
    let best = Infinity;
    for (const [x1, y1, x2, y2] of segs) {
      const vx = x2 - x1;
      const vy = y2 - y1;
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / l2));
      best = Math.min(best, Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)));
    }
    return best;
  };
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const sx = mirrored ? W - 1 - x : x;
      let cover = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) if (dist(sx + (i + 0.5) / SS, y + (j + 0.5) / SS) <= half) cover++;
      const a = cover / (SS * SS);
      const o = y * (W * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(bg[k]! * (1 - a) + fg[k]! * a);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const rgb = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/client/src/world/assets");
const code = EGG_RULES.E7_CODE;
writeFileSync(path.join(out, "mirror-wall.png"), render(code, rgb(0xc8ccd6), rgb(0x2a2f38), true));
writeFileSync(path.join(out, "mirror-glass.png"), render(code, rgb(0x7a8494), rgb(0x9fb0c0), false));
console.log(`wrote ${out}/mirror-wall.png and mirror-glass.png`);

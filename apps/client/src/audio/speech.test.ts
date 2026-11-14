import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPOKEN_LINES, textKey } from "@firstlight/shared/content/dialogue";
import manifest from "./voiceLines.json";
import { hasVoice, subtitleMs, voiceUrl } from "./speech.ts";

const lines = manifest.lines as Record<string, { k: string; ms: number }>;
const file = (id: string) => fileURLToPath(new URL(`../../public/voice/${id}.mp3`, import.meta.url));

describe("spoken lines", () => {
  it("every spoken line has a recording made from its current words (tools/voice/generate.ts)", () => {
    const missing = SPOKEN_LINES.filter((l) => !hasVoice(l.id)).map((l) => l.id);
    expect(missing, "run: node tools/voice/generate.ts").toEqual([]);
    for (const l of SPOKEN_LINES) expect(existsSync(file(l.id)), l.id).toBe(true);
  });

  it("the manifest lists only spoken lines, each file small", () => {
    const ids = new Set(SPOKEN_LINES.map((l) => l.id));
    let total = 0;
    for (const id of Object.keys(lines)) {
      expect(ids.has(id), id).toBe(true);
      const bytes = statSync(file(id)).size;
      expect(bytes, id).toBeLessThan(40_000);
      total += bytes;
    }
    expect(total).toBeLessThan(3.6e6); // the repo budget for model output (brief: about 3 MB)
  });

  it("plays a file only when it matches the text", () => {
    const l = SPOKEN_LINES[0]!;
    expect(hasVoice(l.id, { [l.id]: { k: textKey(l.text), ms: 1000 } })).toBe(true);
    expect(hasVoice(l.id, { [l.id]: { k: textKey(`${l.text}!`), ms: 1000 } })).toBe(false);
    expect(hasVoice("nobody.says.this", { "nobody.says.this": { k: "x", ms: 1 } })).toBe(false);
  });

  it("subtitles last at least as long as the recording, and files sit under the base path", () => {
    const l = SPOKEN_LINES[0]!;
    expect(subtitleMs(l.id, l.text, { [l.id]: { k: textKey(l.text), ms: 8000 } })).toBeGreaterThanOrEqual(8000);
    expect(subtitleMs(l.id, "Hi.", {})).toBe(2500 + 3 * 45);
    expect(voiceUrl("lark.greet.1", "/")).toBe("/voice/lark.greet.1.mp3");
    expect(voiceUrl("lark.greet.1", "/play")).toBe("/play/voice/lark.greet.1.mp3");
  });
});

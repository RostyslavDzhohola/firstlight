// Check every recording by measurement (nobody listens to 247 lines): each spoken line has its file
// and each file a line; the manifest's lengths match the files; loudness, peak, length, pace and gaps
// sit inside VOICE_BANDS (tools/voice/lib.ts); nothing is silent or clipped. Prints the outliers and
// exits 1 when there are any. Regenerate one with `node tools/voice/generate.ts --only <id>`.
//
//   node tools/voice/check.ts            # table of outliers and a summary
//   node tools/voice/check.ts --json     # every measurement, for a closer look

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SPOKEN_LINES, textKey } from "../../packages/shared/src/content/dialogue.ts";
import { judge, type Measured, type VoiceManifest } from "./lib.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILES = join(ROOT, "apps/client/public/voice");
const manifest = JSON.parse(readFileSync(join(ROOT, "apps/client/src/audio/voiceLines.json"), "utf8")) as VoiceManifest;
const run = promisify(execFile);

async function measure(id: string): Promise<Measured> {
  const f = join(FILES, `${id}.mp3`);
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=peak=sample,silencedetect=n=-45dB:d=0.3,astats=measure_perchannel=none", "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp, s = stderr) => Number(re.exec(s)?.[1] ?? NaN);
  const samples = num(/Number of samples: (\d+)/);
  const sec = samples / 24000;
  // Silences inside the line (the edges are trimmed by generate.ts, so a long one is a stall).
  let gap = 0;
  for (const m of stderr.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)) {
    const end = Number(m[1]);
    const dur = Number(m[2]);
    if (end - dur > 0.05 && end < sec - 0.05) gap = Math.max(gap, dur);
  }
  return {
    id,
    sec,
    lufs: num(/I:\s+(-?[\d.]+) LUFS/, summary),
    peak: num(/Peak:\s+(-?[\d.inf]+) dBFS/, summary),
    flat: num(/Flat factor: ([\d.]+)/),
    gap,
  };
}

const lines = new Map(SPOKEN_LINES.map((l) => [l.id, l]));
const problems: string[] = [];
for (const l of SPOKEN_LINES) {
  if (!existsSync(join(FILES, `${l.id}.mp3`))) problems.push(`${l.id}: no file`);
  const e = manifest.lines[l.id];
  if (!e) problems.push(`${l.id}: not in the manifest`);
  else if (e.k !== textKey(l.text)) problems.push(`${l.id}: recorded from other words`);
}
for (const f of readdirSync(FILES)) if (f.endsWith(".mp3") && !lines.has(f.slice(0, -4))) problems.push(`${f}: no spoken line`);
for (const id of Object.keys(manifest.lines)) if (!lines.has(id)) problems.push(`${id}: manifest entry for no spoken line`);

const ids = SPOKEN_LINES.map((l) => l.id).filter((id) => existsSync(join(FILES, `${id}.mp3`)));
const measured: Measured[] = [];
for (let i = 0; i < ids.length; i += 6) measured.push(...(await Promise.all(ids.slice(i, i + 6).map(measure))));

const verdicts = judge(
  measured.map((m) => ({ ...m, text: lines.get(m.id)!.text, speaker: lines.get(m.id)!.speaker, manifestMs: manifest.lines[m.id]?.ms ?? 0 })),
);
for (const v of verdicts) for (const why of v.why) problems.push(`${v.id}: ${why}`);

if (process.argv.includes("--json")) console.log(JSON.stringify(verdicts, null, 1));
const stat = (k: "sec" | "lufs" | "peak") => {
  const xs = measured.map((m) => m[k]).sort((a, b) => a - b);
  return `${xs[0]!.toFixed(1)} … ${xs[xs.length - 1]!.toFixed(1)} (median ${xs[xs.length >> 1]!.toFixed(1)})`;
};
console.log(`${measured.length} files / ${SPOKEN_LINES.length} lines; length s ${stat("sec")}; loudness LUFS ${stat("lufs")}; peak dBFS ${stat("peak")}`);
for (const p of problems) console.log(`  ${p}`);
console.log(problems.length ? `${problems.length} problems` : "no outliers");
process.exit(problems.length ? 1 : 0);

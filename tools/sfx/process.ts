// Turn the raw ElevenLabs takes ($FL_SFX_OUT/raw, from generate.ts) into the upload-ready set
// ($FL_SFX_OUT/<SET>/: mono MP3s, manifest.json, NOTICE.txt), a per-take analysis with spectrograms,
// and the owner's preview page ($FL_SFX_OUT/index.html). Nothing here costs credits or touches the repo.
//
//   node tools/sfx/process.ts
//
// Each kept take is trimmed for low latency (lead-in cut, tail ended at −50 dB, capped, faded),
// and levelled so the sound plays as loud as the ZzFX stand-in it replaces (+ the spec's `level`):
// every take of a sound gets the same file loudness, and the manifest's gain makes up the rest.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS, type PresetName } from "../../apps/client/src/audio/presets.ts";
import { fallbackOf } from "../../apps/client/src/audio/sounds.ts";
import { decode, encodeMp3, loudness, onsets, OUT, peakDb, RATE, spectrum, trim, wav } from "./lib.ts";
import { SET, SOUNDS, type SoundSpec } from "./sounds.ts";

const RAW = join(OUT, "raw");
const SETDIR = join(OUT, SET);
const ANALYSIS = join(OUT, "analysis");
const ZZ = join(OUT, "zzfx");
/** The game's default master × SFX volume: what the preview's "in game" buttons apply. */
const BUS = 0.8 * 0.8;
const PEAK_DB = -1;
/** Playback gain cap: a −1 dBFS file at this gain stays under full scale through the default bus. */
const GAIN_MAX = 1.4;

rmSync(SETDIR, { recursive: true, force: true });
for (const d of [SETDIR, ANALYSIS, ZZ]) mkdirSync(d, { recursive: true });

// ZzFX stand-ins, rendered the way the game builds them (seeded so the reference is stable).
(globalThis as { AudioContext?: unknown }).AudioContext ??= class {};
const { ZZFX } = (await import(new URL("../../apps/client/node_modules/zzfx/ZzFX.js", import.meta.url).href)) as {
  ZZFX: { buildSamples: (...p: (number | undefined)[]) => Float32Array; sampleRate: number };
};
const zzCache = new Map<PresetName, Float32Array>();
function zzfx(preset: PresetName): Float32Array {
  let x = zzCache.get(preset);
  if (x) return x;
  const random = Math.random;
  let seed = 7;
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const samples = ZZFX.buildSamples(...PRESETS[preset]);
  Math.random = random;
  const file = join(ZZ, `${preset}.wav`);
  writeFileSync(file, wav(Array.from(samples, (v) => v * BUS), ZZFX.sampleRate));
  x = decode(file).map((v) => v / BUS); // at 48 kHz, unscaled
  zzCache.set(preset, x);
  return x;
}

interface TakeReport {
  take: number;
  file: string | null;
  dropped?: string;
  rawMs: number;
  ms: number;
  bytes: number;
  peak: number;
  loud: number;
  onsets: number;
  centroid: number;
  toneHz: number;
  toneDb: number;
  prompt: string;
}

interface SoundReport {
  spec: SoundSpec;
  preset: PresetName;
  refLoud: number;
  target: number;
  fileLoud: number;
  gain: number;
  takes: TakeReport[];
}

const log = existsSync(join(RAW, "log.jsonl"))
  ? readFileSync(join(RAW, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; take: number; prompt: string; cost: number })
  : [];
const spent = log.reduce((a, l) => a + l.cost, 0);

const reports: SoundReport[] = [];
const manifest: { set: string; note: string; sounds: Record<string, { files: string[]; gain: number }> } = {
  set: SET,
  note: "Generated with ElevenLabs for FIRSTLIGHT. Not licensed for reuse; not part of the CC BY 4.0 art.",
  sounds: {},
};

for (const spec of SOUNDS) {
  const fb = fallbackOf(spec.name);
  const ref = zzfx(fb.preset).map((v) => v * fb.gain);
  const refLoud = loudness(ref);
  const target = refLoud + (spec.level ?? 0);
  const takes: { n: number; y: Float32Array; rawMs: number; dropped?: string; prompt: string }[] = [];
  spec.prompts.forEach((prompt, i) => {
    const raw = join(RAW, `${spec.name}-${i + 1}.mp3`);
    if (!existsSync(raw)) return;
    const x = decode(raw);
    takes.push({ n: i + 1, y: trim(x, spec.maxMs, spec.fadeMs), rawMs: (x.length / RATE) * 1000, dropped: spec.drop?.[i + 1], prompt });
  });
  if (!takes.length) continue;
  // One file loudness for every kept take: the target, or lower if a take would peak past −1 dBFS.
  const kept = takes.filter((t) => !t.dropped);
  const reach = Math.min(...(kept.length ? kept : takes).map((t) => loudness(t.y) + (PEAK_DB - peakDb(t.y))));
  const fileLoud = Math.min(target, reach);
  const gain = Math.round(Math.min(GAIN_MAX, 10 ** ((target - fileLoud) / 20)) * 1000) / 1000;
  const out: TakeReport[] = [];
  for (const t of takes) {
    const g = 10 ** ((fileLoud - loudness(t.y)) / 20);
    const y = t.y.map((v) => v * g);
    const name = `${spec.name}-${t.n}.mp3`;
    const file = join(t.dropped ? ANALYSIS : SETDIR, name);
    encodeMp3(y, file);
    const s = spectrum(y);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-lavfi", "showspectrumpic=s=360x140:legend=0:scale=log:stop=16000", join(ANALYSIS, `${spec.name}-${t.n}.png`)]);
    out.push({ take: t.n, file: t.dropped ? null : `${SET}/${name}`, dropped: t.dropped, rawMs: Math.round(t.rawMs), ms: Math.round((y.length / RATE) * 1000), bytes: statSync(file).size, peak: peakDb(y), loud: loudness(y), onsets: onsets(y), centroid: s.centroid, toneHz: s.toneHz, toneDb: s.toneDb, prompt: t.prompt });
  }
  const files = out.filter((t) => t.file).map((t) => `${spec.name}-${t.take}.mp3`);
  if (files.length) manifest.sounds[spec.name] = { files, gain };
  reports.push({ spec, preset: fb.preset, refLoud, target, fileLoud, gain, takes: out });
}

writeFileSync(join(SETDIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(SETDIR, "NOTICE.txt"), `${manifest.note}\n`);
writeFileSync(join(ANALYSIS, "report.json"), JSON.stringify(reports.map((r) => ({ ...r, spec: r.spec.name })), null, 2));

// Spectrogram sheets, one per sound (takes side by side), for a quick visual check.
for (const r of reports) {
  const pngs = r.takes.map((t) => join(ANALYSIS, `${r.spec.name}-${t.take}.png`));
  const args = pngs.flatMap((p) => ["-i", p]);
  const filter = pngs.length > 1 ? `hstack=inputs=${pngs.length}` : "null";
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, "-filter_complex", filter, join(ANALYSIS, `sheet-${r.spec.name}.png`)]);
}

// ------------------------------------------------------------------ console summary
const f1 = (v: number) => v.toFixed(1);
for (const r of reports) {
  const short = r.target - (r.fileLoud + 20 * Math.log10(r.gain));
  console.log(`${r.spec.name.padEnd(12)} ref ${f1(r.refLoud)} → target ${f1(r.target)}, files ${f1(r.fileLoud)}, gain ${r.gain}${short > 0.1 ? ` (peak-capped, ${f1(short)} dB under target)` : ""}`);
  for (const t of r.takes) {
    console.log(`   ${String(t.take).padStart(2)} ${t.dropped ? "DROP" : "keep"} ${String(t.rawMs).padStart(5)}→${String(t.ms).padStart(5)} ms ${String(t.bytes).padStart(6)} B peak ${f1(t.peak).padStart(5)} onsets ${t.onsets} centroid ${t.centroid.toFixed(0).padStart(5)} tone ${t.toneHz.toFixed(0).padStart(5)} Hz +${f1(t.toneDb)}${t.dropped ? `  (${t.dropped})` : ""}`);
  }
}
const kept = reports.flatMap((r) => r.takes.filter((t) => t.file));
console.log(`\n${Object.keys(manifest.sounds).length} sounds, ${kept.length} files, ${(kept.reduce((a, t) => a + t.bytes, 0) / 1024).toFixed(0)} KB; ${spent} credits spent (raw/log.jsonl)`);

// ------------------------------------------------------------------ preview page
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LIVE = join(OUT, "zzfx-live");
const rows = [...reports]
  .sort((a, b) => a.spec.priority - b.spec.priority)
  .map((r) => {
    const live = existsSync(join(LIVE, `${r.preset}.wav`)) ? `zzfx-live/${r.preset}.wav` : `zzfx/${r.preset}.wav`;
    const takes = r.takes
      .map(
        (t) => `<figure class="${t.dropped ? "drop" : ""}"><figcaption>take ${t.take} · ${t.ms} ms · ${(t.bytes / 1024).toFixed(1)} KB${t.dropped ? ` · <b>not used</b>: ${esc(t.dropped)}` : ""}</figcaption>
          <audio controls preload="none" src="${t.file ?? `analysis/${r.spec.name}-${t.take}.mp3`}"></audio></figure>`,
      )
      .join("\n");
    const files = JSON.stringify(r.takes.filter((t) => t.file).map((t) => t.file));
    return `<tr><td><b>${r.spec.name}</b><br><span class="p">priority ${r.spec.priority}</span></td>
      <td>${esc(r.spec.event)}</td>
      <td><figure><figcaption>live today (ZzFX “${r.preset}”)</figcaption><audio controls preload="none" src="${live}"></audio></figure>
        <figure><figcaption>fallback now (ZzFX)</figcaption><audio controls preload="none" src="zzfx/${r.preset}.wav"></audio></figure></td>
      <td>${takes}<div><button data-files='${files}' data-gain="${r.gain}">▶ as in game ×6</button><span class="p"> playback gain ${r.gain} · ${f1(r.target)} LUFS (loudest 400 ms)</span></div></td></tr>`;
  })
  .join("\n");

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>FIRSTLIGHT sound effects preview (${SET})</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#111418;color:#e8e6e1}
  h1{font-size:20px;margin:0 0 4px} p{max-width:900px;color:#b9b6ae}
  table{border-collapse:collapse;width:100%} td{border-top:1px solid #2a2f36;padding:10px 8px;vertical-align:top}
  td:first-child{width:130px} td:nth-child(2){width:200px;color:#b9b6ae}
  figure{display:inline-block;margin:0 10px 8px 0} figcaption{font-size:12px;color:#8d8a83}
  figure.drop{opacity:.45} audio{height:32px;width:220px} .p{font-size:12px;color:#8d8a83}
  button{background:#2b6cb0;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;margin-top:4px}
</style>
<h1>FIRSTLIGHT sound effects: ElevenLabs set “${SET}”</h1>
<p>Each row is one game event. Left: what plays today (ZzFX) and the softened ZzFX stand-in that plays if a file is missing.
Right: the new ElevenLabs takes (trimmed, mono MP3). The game picks a random take each time (never the same twice in a row)
with ±6 % pitch and up to −1.5 dB level jitter; “as in game ×6” plays six in a row like that, at the in-game level next to the live ZzFX.
Greyed takes are left out of the set. ${kept.length} files, ${(kept.reduce((a, t) => a + t.bytes, 0) / 1024).toFixed(0)} KB, ${spent} ElevenLabs credits.</p>
<table>${rows}</table>
<script>
  // Plain <audio> playback so the page also works opened straight from disk (file:// can't fetch).
  for (const b of document.querySelectorAll("button[data-files]")) b.onclick = () => {
    const files = JSON.parse(b.dataset.files); let last = -1;
    for (let k = 0; k < 6; k++) {
      let i = Math.floor(Math.random() * files.length); if (files.length > 1 && i === last) i = (i + 1) % files.length; last = i;
      setTimeout(() => {
        const a = new Audio(files[i]); a.preservesPitch = false; a.playbackRate = 0.94 + Math.random() * 0.12;
        a.volume = Math.min(1, ${BUS} * Number(b.dataset.gain) * (0.84 + Math.random() * 0.16)); void a.play();
      }, k * 450);
    }
  };
</script>
`,
);
console.log(`preview: ${join(OUT, "index.html")}`);

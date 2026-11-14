// Record every spoken line (packages/shared/src/content/dialogue.ts SPOKEN_LINES) with Kokoro-82M,
// a free local text-to-speech model (Apache-2.0 weights; docs/ASSETS.md "Voices"), and write the
// files the game plays: apps/client/public/voice/<id>.mp3 and apps/client/src/audio/voiceLines.json.
//
//   node tools/voice/generate.ts            # only lines whose text changed or whose file is missing
//   node tools/voice/generate.ts --all      # every line
//   node tools/voice/generate.ts --only lark.greet.1,mission.A1
//   node tools/voice/generate.ts --wavs <dir>  # finish the raw takes a stopped run left in <dir> (its jobs.json)
//   node tools/voice/generate.ts --adopt    # list files recorded by a run that stopped before its manifest
//                                           # (or by two runs side by side): no recording, current text
//
// Setup (once, outside the repo; FL_VOICE_HOME, default ~/.cache/firstlight-voice):
//   python3 -m venv $FL_VOICE_HOME/venv && $FL_VOICE_HOME/venv/bin/pip install kokoro-onnx==0.6.1 soundfile
//   curl -L -o $FL_VOICE_HOME/models/kokoro-v1.0.onnx  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
//   curl -L -o $FL_VOICE_HOME/models/voices-v1.0.bin   https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
//
// Each take is run through the cast's effect (bosses) and a gentle compressor, trimmed, levelled to
// TARGET_LUFS (EBU R128) under a −1.5 dBFS limiter and encoded
// as a mono 24 kHz MP3 at KBPS, like the sound effects (tools/sfx) but smaller: speech needs less.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPOKEN_BY_ID, SPOKEN_LINES, textKey } from "../../packages/shared/src/content/dialogue.ts";
import { decode, RATE, wav } from "../sfx/lib.ts";
import { CAST, langOf } from "./cast.ts";
import { PEAK_DBFS, stale, TARGET_LUFS, trimSpeech, type VoiceManifest } from "./lib.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILES = join(ROOT, "apps/client/public/voice");
const MANIFEST = join(ROOT, "apps/client/src/audio/voiceLines.json");
const HOME = process.env.FL_VOICE_HOME ?? join(homedir(), ".cache/firstlight-voice");
const PY = join(HOME, "venv/bin/python");
const MODELS = join(HOME, "models");
const KBPS = 24;
/** Lines per model run: each run loads the model (a few seconds), each chunk is saved before the next. */
const CHUNK = 12;
const COMPRESS = "acompressor=threshold=-24dB:ratio=3:attack=8:release=120:makeup=2";
const MODEL = "Kokoro-82M v1.0 (kokoro-onnx 0.6.1, kokoro-v1.0.onnx fp32)";

/** EBU R128 integrated loudness of a file (LUFS), as ffmpeg measures it. */
function ebuLoudness(f: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", f, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const m = /I:\s+(-?[\d.]+) LUFS\s+Threshold/.exec(r.stderr.slice(r.stderr.lastIndexOf("Summary:")));
  if (!m) throw new Error(`no loudness for ${f}`);
  return Number(m[1]);
}

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const all = process.argv.includes("--all");
const only = arg("only")?.split(",").filter(Boolean);
const adopt = process.argv.includes("--adopt");

mkdirSync(FILES, { recursive: true });
const file = (id: string) => join(FILES, `${id}.mp3`);
const readManifest = (): VoiceManifest => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { model: MODEL, kbps: KBPS, lines: {} });
const ids = new Set(SPOKEN_LINES.map((l) => l.id));

/**
 * Add entries and write the manifest: re-read from disk first, so two runs side by side (or a run
 * that was stopped) never drop each other's lines. Only spoken lines with a file are kept.
 */
function save(add: VoiceManifest["lines"]) {
  const m = readManifest();
  Object.assign(m.lines, add);
  const lines = Object.fromEntries(Object.entries(m.lines).filter(([id]) => ids.has(id) && existsSync(file(id))).sort(([x], [y]) => x.localeCompare(y)));
  writeFileSync(MANIFEST, `${JSON.stringify({ model: MODEL, kbps: KBPS, lines }, null, 1)}\n`);
}

/** A raw take (24 kHz WAV) to the shipped file: effect, compressor, trim, level, limit, MP3. Returns its length. */
function finish(id: string, raw: string, work: string): number {
  const fx = CAST[SPOKEN_LINES.find((x) => x.id === id)!.speaker].fx;
  // The cast's effect, then a gentle compressor so quiet words carry in a noisy fight.
  const shaped = join(work, `${id}.shaped.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", [fx, COMPRESS].filter(Boolean).join(","), shaped]);
  const y = trimSpeech(decode(shaped));
  const trimmed = join(work, `${id}.trim.wav`);
  writeFileSync(trimmed, wav(y, RATE));
  const gain = TARGET_LUFS - ebuLoudness(trimmed);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", trimmed, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=${PEAK_DBFS}dB:level=false:attack=2:release=40`, "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", `${KBPS}k`, "-write_xing", "1", file(id)]);
  rmSync(shaped);
  rmSync(trimmed);
  return Math.round((y.length / RATE) * 1000);
}

const current = readManifest();
if (adopt) {
  const add: VoiceManifest["lines"] = {};
  for (const l of SPOKEN_LINES) {
    if (current.lines[l.id] || !existsSync(file(l.id))) continue;
    const sec = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file(l.id)], { encoding: "utf8" }).trim());
    add[l.id] = { k: textKey(l.text), ms: Math.round(sec * 1000) };
  }
  save(add);
}
const fromWavs = arg("wavs");
if (fromWavs) {
  // Takes a stopped run left behind: kept only where its jobs.json text is still the line's text.
  const jobs = JSON.parse(readFileSync(join(fromWavs, "jobs.json"), "utf8")) as { id: string; text: string; out: string }[];
  const add: VoiceManifest["lines"] = {};
  for (const j of jobs) {
    const l = SPOKEN_BY_ID.get(j.id);
    if (!l || l.text !== j.text || !existsSync(j.out)) continue;
    add[j.id] = { k: textKey(l.text), ms: finish(j.id, j.out, fromWavs) };
  }
  save(add);
  console.log(`kept ${Object.keys(add).length} takes from ${fromWavs}`);
}
const todo = adopt || fromWavs ? [] : (only ?? (all ? SPOKEN_LINES.map((l) => l.id) : stale(SPOKEN_LINES, current, textKey, (id) => existsSync(file(id)))));

if (todo.length) {
  if (!existsSync(PY) || !existsSync(join(MODELS, "kokoro-v1.0.onnx"))) throw new Error(`Kokoro is not set up in ${HOME}: see the setup lines at the top of this file`);
  const work = join(tmpdir(), `fl-voice-${process.pid}`);
  mkdirSync(work, { recursive: true });
  console.log(`recording ${todo.length} lines with ${MODEL}`);
  // In chunks, each finished and saved before the next: a stopped run keeps what it made.
  for (let c = 0; c < todo.length; c += CHUNK) {
    const jobs = todo.slice(c, c + CHUNK).map((id) => {
      const l = SPOKEN_BY_ID.get(id);
      if (!l) throw new Error(`no spoken line ${id}`);
      const v = CAST[l.speaker];
      return { id, text: l.text, voice: v.voice, lang: langOf(v.voice), speed: v.speed, out: join(work, `${id}.wav`) };
    });
    writeFileSync(join(work, "jobs.json"), JSON.stringify(jobs));
    const r = spawnSync(PY, ["-I", join(ROOT, "tools/voice/kokoro_tts.py"), MODELS, join(work, "jobs.json")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`kokoro_tts.py exited ${r.status}`);
    const add: VoiceManifest["lines"] = {};
    for (const j of jobs) add[j.id] = { k: textKey(j.text), ms: finish(j.id, j.out, work) };
    save(add);
    console.log(`saved ${Math.min(todo.length, c + CHUNK)}/${todo.length}`);
  }
  rmSync(work, { recursive: true, force: true });
}

// Drop files for lines that are no longer spoken (only on a full pass: a partial run may race another).
if (!only && !fromWavs) for (const f of readdirSync(FILES)) if (f.endsWith(".mp3") && !ids.has(f.slice(0, -4))) rmSync(join(FILES, f));
save({});
const lines = readManifest().lines;

const bytes = readdirSync(FILES).reduce((s, f) => s + statSync(join(FILES, f)).size, 0);
const ms = Object.values(lines).reduce((s, l) => s + l.ms, 0);
console.log(`${Object.keys(lines).length}/${SPOKEN_LINES.length} lines, ${(ms / 60000).toFixed(1)} min, ${(bytes / 1e6).toFixed(2)} MB in apps/client/public/voice`);

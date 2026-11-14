// One-time setup of the voice tool's model environment, outside the repo (FL_VOICE_HOME, default
// ~/.cache/firstlight-voice): a Python virtual environment with the pinned packages
// (tools/voice/requirements.txt) and the Kokoro-82M ONNX model files, each checked by sha256 and
// downloaded only when missing or wrong. Safe to run again; it only fixes what is missing.
//
//   node tools/voice/setup.ts
//
// Prerequisites on the machine: Node 24, Python 3.11–3.13 (kokoro-onnx 0.6.1 does not install on
// 3.14+, the pinned numpy needs 3.11+; set PYTHON=/path/to/python3.x to choose one), FFmpeg and ffprobe on PATH with the
// libmp3lame encoder (macOS: `brew install ffmpeg python@3.12`; Debian/Ubuntu: `apt install ffmpeg
// python3 python3-venv`). The phonemizer's espeak-ng comes inside a wheel (espeakng-loader).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_FILES, voiceHome } from "./lib.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOME = voiceHome();
const MODELS = join(HOME, "models");
const VENV = join(HOME, "venv");
const PY = join(VENV, "bin/python");

const ok = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
function fail(msg: string): never {
  console.error(`voice setup: ${msg}`);
  process.exit(1);
}

// FFmpeg with MP3 encoding (generate.ts shapes, measures and encodes every line with it).
for (const tool of ["ffmpeg", "ffprobe"]) if (ok(tool, ["-version"]).status !== 0) fail(`${tool} is not on PATH (install FFmpeg)`);
if (!/libmp3lame/.test(ok("ffmpeg", ["-hide_banner", "-encoders"]).stdout)) fail("this ffmpeg has no libmp3lame encoder");

/** A Python's "3.x" version, or null when it doesn't run. */
function version(py: string): string | null {
  const r = ok(py, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
  return r.status === 0 ? r.stdout.trim() : null;
}
const usable = (v: string | null) => !!v && /^3\.1[123]$/.test(v);

/** A Python the pinned set installs on: PYTHON if set, else the newest python3.13 … 3.11, else python3. */
function findPython(): string {
  const tries = process.env.PYTHON ? [process.env.PYTHON] : ["python3.13", "python3.12", "python3.11", "python3"];
  for (const p of tries) {
    const v = version(p);
    if (usable(v)) return p;
    if (process.env.PYTHON) fail(`PYTHON is ${v ?? "not runnable"}; the voice tool needs Python 3.11–3.13`);
  }
  return fail("no Python 3.11–3.13 found (install one, e.g. brew install python@3.12, or set PYTHON=/path/to/python3.x)");
}

mkdirSync(MODELS, { recursive: true });
if (existsSync(PY) && !usable(version(PY))) {
  console.log(`${VENV} was made with Python ${version(PY) ?? "(broken)"}: making it again`);
  rmSync(VENV, { recursive: true, force: true });
}
if (!existsSync(PY)) {
  const py = findPython();
  console.log(`creating ${VENV} with ${py}`);
  if (ok(py, ["-m", "venv", VENV]).status !== 0) fail(`${py} -m venv failed (Debian/Ubuntu: apt install python3-venv)`);
}
console.log("installing tools/voice/requirements.txt");
const pip = spawnSync(PY, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", join(ROOT, "tools/voice/requirements.txt")], { stdio: "inherit" });
if (pip.status !== 0) fail("pip install failed");

const sha256 = (f: string) =>
  new Promise<string>((res, rej) => {
    const h = createHash("sha256");
    createReadStream(f).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });

for (const m of MODEL_FILES) {
  const f = join(MODELS, m.name);
  if (existsSync(f) && (await sha256(f)) === m.sha256) {
    console.log(`${m.name}: present, sha256 ok`);
    continue;
  }
  console.log(`${m.name}: downloading ${m.url}`);
  const r = await fetch(m.url);
  if (!r.ok) fail(`${m.url}: HTTP ${r.status}`);
  const part = `${f}.part`;
  writeFileSync(part, Buffer.from(await r.arrayBuffer()));
  const got = await sha256(part);
  if (got !== m.sha256) {
    rmSync(part);
    fail(`${m.name}: sha256 ${got}, expected ${m.sha256}`);
  }
  renameSync(part, f);
}

// The runner loads: the model, its voices and the phonemizer all import.
const smoke = ok(PY, ["-I", "-c", `import kokoro_onnx, soundfile; kokoro_onnx.Kokoro(${JSON.stringify(join(MODELS, "kokoro-v1.0.onnx"))}, ${JSON.stringify(join(MODELS, "voices-v1.0.bin"))}).create("Ready.", voice="af_heart", lang="en-us"); print("ok")`]);
if (smoke.status !== 0 || !smoke.stdout.includes("ok")) fail(`the Kokoro runner did not start:\n${smoke.stderr}`);
console.log(`voice tool ready in ${HOME}: run node tools/voice/generate.ts`);

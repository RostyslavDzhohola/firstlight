// Generate the raw ElevenLabs takes for the SFX set (tools/sfx/sounds.ts) into $FL_SFX_OUT/raw
// (default /tmp/fl-go/sfx/raw; never the repo). Takes that already exist are skipped, so a rerun only
// pays for what's missing. Spends at most --budget credits and never more than the account has left.
//
//   node tools/sfx/generate.ts --dry-run                 # plan and cost, no requests
//   node tools/sfx/generate.ts --budget 150 --max-priority 3
//   node tools/sfx/generate.ts --budget 40 --only hitmark,ui
//
// The key comes from ELEVENLABS_API_KEY or ~/.config/firstlight/.env and is never printed.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { apiKey, OUT } from "./lib.ts";
import { estimateCredits, SOUNDS } from "./sounds.ts";
import { creditsLeft, generateTakes, parseBudget, type Job, type SpendIo } from "./spend.ts";

const { values: args } = parseArgs({
  options: {
    budget: { type: "string", default: "0" },
    "max-priority": { type: "string", default: "6" },
    only: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const budget = parseBudget(args.budget);
const maxPriority = Number(args["max-priority"]);
if (!Number.isFinite(maxPriority)) throw new Error(`--max-priority must be a number, got "${args["max-priority"]}"`);
const only = args.only ? new Set(args.only.split(",")) : null;
const raw = join(OUT, "raw");

const jobs: Job[] = [];
for (const s of [...SOUNDS].sort((a, b) => a.priority - b.priority)) {
  if (s.priority > maxPriority || (only && !only.has(s.name))) continue;
  s.prompts.forEach((prompt, i) => {
    const file = join(raw, `${s.name}-${i + 1}.mp3`);
    if (!existsSync(file)) jobs.push({ name: s.name, take: i + 1, prompt, seconds: s.seconds, influence: s.influence, file, estimate: estimateCredits(s.seconds) });
  });
}
const planned = jobs.reduce((a, j) => a + j.estimate, 0);
console.log(`${jobs.length} takes to generate, about ${planned} credits`);
for (const j of jobs) console.log(`  ${j.name}-${j.take}  ${j.seconds} s  ~${j.estimate}`);

if (args["dry-run"] || !jobs.length) process.exit(0);

mkdirSync(raw, { recursive: true });
const io: SpendIo = {
  fetch,
  save(j, bytes, cost) {
    writeFileSync(j.file, bytes);
    appendFileSync(join(raw, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), name: j.name, take: j.take, prompt: j.prompt, seconds: j.seconds, influence: j.influence, cost: cost ?? j.estimate, costReported: cost !== null }) + "\n");
  },
  log: (line) => console.log(line),
};
const key = apiKey();
const r = await generateTakes(jobs, budget, key, io);
const after = await creditsLeft(io, key).then((a) => `${a.left}`, (e: unknown) => `unknown (${String(e)})`);
console.log(`done: ${r.made} takes, ${r.billed} credits by the response headers (${r.committed} committed); the account shows ${after} left (it lags)`);

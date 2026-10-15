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

const API = "https://api.elevenlabs.io/v1";

const { values: args } = parseArgs({
  options: {
    budget: { type: "string", default: "0" },
    "max-priority": { type: "string", default: "6" },
    only: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const budget = Number(args.budget);
const maxPriority = Number(args["max-priority"]);
const only = args.only ? new Set(args.only.split(",")) : null;
const raw = join(OUT, "raw");
mkdirSync(raw, { recursive: true });

interface Job {
  name: string;
  take: number;
  prompt: string;
  seconds: number;
  influence: number;
  file: string;
  estimate: number;
}

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

async function subscription(key: string): Promise<{ used: number; limit: number; reset: string }> {
  const r = await fetch(`${API}/user/subscription`, { headers: { "xi-api-key": key } });
  if (!r.ok) throw new Error(`subscription: HTTP ${r.status}`);
  const d = (await r.json()) as { character_count: number; character_limit: number; next_character_count_reset_unix: number };
  return { used: d.character_count, limit: d.character_limit, reset: new Date(d.next_character_count_reset_unix * 1000).toISOString() };
}

if (args["dry-run"] || !jobs.length) process.exit(0);

const key = apiKey();
const sub = await subscription(key);
const left = sub.limit - sub.used;
console.log(`account: ${left} credits left of ${sub.limit} (resets ${sub.reset}); budget ${budget}`);
const cap = Math.min(budget, left);
let spent = 0;
for (const j of jobs) {
  if (spent + j.estimate > cap) {
    console.log(`stop: ${j.name}-${j.take} (~${j.estimate}) would pass the cap of ${cap} (spent ${spent})`);
    break;
  }
  const r = await fetch(`${API}/sound-generation?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: j.prompt, duration_seconds: j.seconds, prompt_influence: j.influence, model_id: "eleven_text_to_sound_v2" }),
  });
  if (!r.ok) {
    console.log(`fail: ${j.name}-${j.take}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    if (r.status === 401 || r.status === 402 || r.status === 429) break;
    continue;
  }
  const cost = Number(r.headers.get("character-cost") ?? j.estimate);
  writeFileSync(j.file, Buffer.from(await r.arrayBuffer()));
  spent += cost;
  appendFileSync(join(raw, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), name: j.name, take: j.take, prompt: j.prompt, seconds: j.seconds, influence: j.influence, cost }) + "\n");
  console.log(`ok: ${j.name}-${j.take}  ${cost} credits (spent ${spent})`);
}
const after = await subscription(key);
console.log(`done: ${spent} credits by the response headers; the account shows ${after.limit - after.used} left`);

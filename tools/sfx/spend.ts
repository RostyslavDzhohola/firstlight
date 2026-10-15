// The paid part of generate.ts, apart so its budget rules can be tested with a fake fetch:
// - the account balance must be well-formed, or nothing is requested;
// - each take's estimated cost is reserved before its request, so the cap holds even if billing
//   data turns out bad; a failed request keeps its reservation (it may have been billed);
// - a missing or malformed `character-cost` header, or a charge above the estimate, stops the run.

export const API = "https://api.elevenlabs.io/v1";

export interface Job {
  name: string;
  take: number;
  prompt: string;
  seconds: number;
  influence: number;
  file: string;
  estimate: number;
}

export interface SpendIo {
  fetch: typeof fetch;
  /** Store a generated take (it's paid for, so it's kept even when the run stops after it). */
  save(job: Job, bytes: Buffer, cost: number | null): void;
  log(line: string): void;
}

const credits = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** `--budget`: a whole number of credits, 0 or more. */
export function parseBudget(raw: string | undefined): number {
  const n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!credits(n)) throw new Error(`--budget must be a whole number of credits ≥ 0, got "${raw}"`);
  return n;
}

/** Credits left on the account; throws on anything but a well-formed balance. */
export async function creditsLeft(io: SpendIo, key: string): Promise<{ left: number; limit: number; reset: string }> {
  const r = await io.fetch(`${API}/user/subscription`, { headers: { "xi-api-key": key } });
  if (!r.ok) throw new Error(`invalid billing data: subscription HTTP ${r.status}`);
  const d = (await r.json().catch(() => null)) as { character_count?: unknown; character_limit?: unknown; next_character_count_reset_unix?: unknown } | null;
  if (!d || !credits(d.character_count) || !credits(d.character_limit) || d.character_count > d.character_limit) {
    throw new Error("invalid billing data: the subscription has no usable character_count/character_limit");
  }
  const reset = typeof d.next_character_count_reset_unix === "number" ? new Date(d.next_character_count_reset_unix * 1000).toISOString() : "unknown";
  return { left: d.character_limit - d.character_count, limit: d.character_limit, reset };
}

/** A `character-cost` header as whole credits, or null if it's missing or malformed. */
export function parseCost(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const n = Number(header);
  return credits(n) ? n : null;
}

export interface SpendResult {
  /** Credits the response headers reported. */
  billed: number;
  /** Billed plus the reservations of requests whose cost is unknown: what the cap is held against. */
  committed: number;
  made: number;
  stop: string | null;
}

/** Generate the takes in order within `budget` and the account's balance. */
export async function generateTakes(jobs: Job[], budget: number, key: string, io: SpendIo): Promise<SpendResult> {
  if (!credits(budget)) throw new Error(`invalid budget ${budget}`);
  const account = await creditsLeft(io, key);
  const cap = Math.min(budget, account.left);
  io.log(`account: ${account.left} credits left of ${account.limit} (resets ${account.reset}); budget ${budget}, cap ${cap}`);
  const res: SpendResult = { billed: 0, committed: 0, made: 0, stop: null };
  const halt = (why: string) => {
    res.stop = why;
    io.log(`stop: ${why}`);
    return res;
  };
  for (const j of jobs) {
    if (!credits(j.estimate) || j.estimate === 0) return halt(`${j.name}-${j.take} has no valid estimate`);
    if (res.committed + j.estimate > cap) return halt(`${j.name}-${j.take} (~${j.estimate}) would pass the cap of ${cap} (committed ${res.committed})`);
    res.committed += j.estimate; // reserved before the request
    const r = await io.fetch(`${API}/sound-generation?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: j.prompt, duration_seconds: j.seconds, prompt_influence: j.influence, model_id: "eleven_text_to_sound_v2" }),
    });
    if (!r.ok) {
      io.log(`fail: ${j.name}-${j.take}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
      if (r.status === 401 || r.status === 402 || r.status === 429) return halt(`HTTP ${r.status} from the API`);
      continue; // the reservation stays
    }
    const cost = parseCost(r.headers.get("character-cost"));
    io.save(j, Buffer.from(await r.arrayBuffer()), cost);
    res.made++;
    if (cost === null) return halt(`invalid billing data: ${j.name}-${j.take} came back without a whole-number character-cost; ${j.estimate} stays reserved`);
    res.billed += cost;
    res.committed += cost - j.estimate;
    io.log(`ok: ${j.name}-${j.take}  ${cost} credits (billed ${res.billed})`);
    if (cost > j.estimate) return halt(`${j.name}-${j.take} cost ${cost}, above the estimate of ${j.estimate}: pricing changed, update estimateCredits`);
  }
  return res;
}

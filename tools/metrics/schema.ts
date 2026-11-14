// The metrics run file (`pnpm metrics`, docs/metrics.md): one JSON per run under tools/bench/results/,
// in a schema a hill climb can read without knowing how each number was taken. Pure code: no I/O.
//
// Each metric: {id, value, unit, better, group, noise[, floor]}.
//   noise  typical run-to-run spread as a fraction of the value (0.05 = ±5 %), measured with
//          `pnpm metrics --repeat 3` (docs/metrics.md lists how each one was measured). 0: deterministic.
//   floor  optional absolute spread in the metric's unit, for counts that sit near 0 (frames over
//          100 ms: 0 → 1 is not a 100 % regression).
// A change is real when it moves past max(noise × |baseline|, floor).

export const GROUPS = ["static", "health", "tests", "load", "frame", "passes", "server", "funnel"] as const;
export type Group = (typeof GROUPS)[number];
export type Better = "lower" | "higher";

export interface Metric {
  id: string;
  value: number;
  unit: string;
  better: Better;
  group: Group;
  noise: number;
  floor?: number;
}

export interface Machine {
  os: string;
  cpu: string;
  cores: number;
  memGB: number;
  node: string;
  /** Other heavy processes were running (load average over cores/2 at the start): frame numbers are noisy. */
  busy: boolean;
  load1: number;
}

export interface MetricsRun {
  v: 1;
  when: string;
  commit: string;
  branch: string;
  dirty: boolean;
  machine: Machine;
  groups: Group[];
  /** How many times each group ran (`--repeat`); values are the medians, noise the observed spread when >1. */
  repeat: number;
  metrics: Metric[];
  /** Free-form remarks: skipped groups, failures, flags. */
  notes: string[];
}

const ID = /^[a-z0-9][a-z0-9_.\-]*$/;

/** Problems with a run file (empty: valid). Checks every field a reader relies on. */
export function validateRun(r: unknown): string[] {
  const errs: string[] = [];
  if (!r || typeof r !== "object") return ["not an object"];
  const o = r as Partial<MetricsRun>;
  if (o.v !== 1) errs.push(`v must be 1 (got ${String(o.v)})`);
  for (const k of ["when", "commit", "branch"] as const) if (typeof o[k] !== "string") errs.push(`${k} must be a string`);
  if (typeof o.dirty !== "boolean") errs.push("dirty must be a boolean");
  if (!o.machine || typeof o.machine !== "object") errs.push("machine missing");
  if (!Array.isArray(o.groups) || o.groups.some((g) => !(GROUPS as readonly string[]).includes(g))) errs.push("groups must list known groups");
  if (!Array.isArray(o.metrics)) return [...errs, "metrics must be an array"];
  const seen = new Set<string>();
  o.metrics.forEach((m, i) => {
    const at = `metrics[${i}]${m && typeof m.id === "string" ? ` (${m.id})` : ""}`;
    errs.push(...validateMetric(m).map((e) => `${at}: ${e}`));
    if (m && typeof m.id === "string") {
      if (seen.has(m.id)) errs.push(`${at}: duplicate id`);
      seen.add(m.id);
    }
  });
  return errs;
}

export function validateMetric(m: unknown): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== "object") return ["not an object"];
  const o = m as Partial<Metric>;
  if (typeof o.id !== "string" || !ID.test(o.id)) errs.push(`id must match ${ID}`);
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) errs.push("value must be a finite number");
  if (typeof o.unit !== "string" || !o.unit) errs.push("unit must be a non-empty string");
  if (o.better !== "lower" && o.better !== "higher") errs.push("better must be lower|higher");
  if (!(GROUPS as readonly string[]).includes(o.group as string)) errs.push(`group must be one of ${GROUPS.join(",")}`);
  if (typeof o.noise !== "number" || !(o.noise >= 0)) errs.push("noise must be a number ≥ 0");
  if (o.floor !== undefined && (typeof o.floor !== "number" || !(o.floor >= 0))) errs.push("floor must be a number ≥ 0");
  return errs;
}

export type Verdict = "better" | "worse" | "same" | "new" | "gone";

export interface Delta {
  id: string;
  unit: string;
  better: Better;
  group: Group;
  a: number | null;
  b: number | null;
  /** b − a (null when one side is missing). */
  delta: number | null;
  /** (b − a) / |a| (null when a is 0 or missing). */
  rel: number | null;
  /** The spread this delta had to beat: max(noise × |a|, floor), using the larger noise of the two runs. */
  threshold: number;
  verdict: Verdict;
}

/** Spread a change must beat to count, for a baseline value `a`. */
export function threshold(a: number, noise: number, floor = 0): number {
  return Math.max(Math.abs(a) * noise, floor);
}

/** Per-metric deltas between run `a` (before) and run `b` (after), in `a`'s order then `b`'s new ids. */
export function compareRuns(a: Pick<MetricsRun, "metrics">, b: Pick<MetricsRun, "metrics">): Delta[] {
  const bm = new Map(b.metrics.map((m) => [m.id, m]));
  const out: Delta[] = [];
  for (const ma of a.metrics) {
    const mb = bm.get(ma.id);
    if (!mb) {
      out.push({ id: ma.id, unit: ma.unit, better: ma.better, group: ma.group, a: ma.value, b: null, delta: null, rel: null, threshold: 0, verdict: "gone" });
      continue;
    }
    const noise = Math.max(ma.noise, mb.noise);
    const floor = Math.max(ma.floor ?? 0, mb.floor ?? 0);
    const t = threshold(ma.value, noise, floor);
    const delta = mb.value - ma.value;
    const rel = ma.value !== 0 ? delta / Math.abs(ma.value) : null;
    const improved = ma.better === "lower" ? delta < 0 : delta > 0;
    const verdict: Verdict = Math.abs(delta) <= t || delta === 0 ? "same" : improved ? "better" : "worse";
    out.push({ id: ma.id, unit: ma.unit, better: ma.better, group: ma.group, a: ma.value, b: mb.value, delta, rel, threshold: t, verdict });
  }
  const ids = new Set(a.metrics.map((m) => m.id));
  for (const mb of b.metrics) {
    if (!ids.has(mb.id)) out.push({ id: mb.id, unit: mb.unit, better: mb.better, group: mb.group, a: null, b: mb.value, delta: null, rel: null, threshold: 0, verdict: "new" });
  }
  return out;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Fold several runs of the same groups into one: each metric's median, and its noise raised to the
 * observed half-spread ((max − min) / 2 / |median|) when that is larger than the catalogue's. A metric
 * missing from some runs keeps the runs that have it.
 */
export function foldRepeats(runs: Metric[][]): Metric[] {
  const byId = new Map<string, Metric[]>();
  const order: string[] = [];
  for (const run of runs)
    for (const m of run) {
      if (!byId.has(m.id)) {
        byId.set(m.id, []);
        order.push(m.id);
      }
      byId.get(m.id)!.push(m);
    }
  return order.map((id) => {
    const ms = byId.get(id)!;
    const vals = ms.map((m) => m.value);
    const med = median(vals);
    const half = (Math.max(...vals) - Math.min(...vals)) / 2;
    const observed = med !== 0 ? half / Math.abs(med) : 0;
    const base = ms[0]!;
    const out: Metric = { ...base, value: round(med), noise: round(Math.max(base.noise, observed), 4) };
    if (med === 0 && half > 0) out.floor = round(Math.max(base.floor ?? 0, half));
    return out;
  });
}

export function round(v: number, digits = 3): number {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

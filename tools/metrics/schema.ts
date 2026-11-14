// The metrics run file (`pnpm metrics`, docs/metrics.md): one JSON per run under tools/bench/results/,
// in a schema a hill climb can read without knowing how each number was taken. Pure code: no I/O.
//
// Each metric: {id, value, unit, better, group, noise[, floor][, gate]}.
//   noise  typical run-to-run spread as a fraction of the value (0.05 = ±5 %), measured with
//          `pnpm metrics --repeat 3` (docs/metrics.md lists how each one was measured). 0: deterministic.
//   floor  optional absolute spread in the metric's unit, for counts that sit near 0 (frames over
//          100 ms: 0 → 1 is not a 100 % regression).
//   gate   a correctness count that must be 0 (failing tests, type errors, shader builds after the
//          warm-up). No tolerance: any change is real, repeats keep the worst run, and a run whose gate
//          is not 0 is never a good result.
// A change is real when it moves past max(noise × |baseline|, floor) (gates: any change).
//
// Each group the run asked for has a status (D-metrics-3): whether every measurement it promised was
// taken, the errors that stopped it, the ids it promised but didn't produce, and its own provenance
// (commit, uncommitted changes, time, machine load). A run file is honest about what it holds; the
// comparison refuses to call a partial, incompatible or busy-machine result better or worse.

export const SCHEMA_VERSION = 2;
export const GROUPS = ["static", "health", "tests", "load", "frame", "passes", "server"] as const;
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
  gate?: true;
}

export interface Machine {
  os: string;
  cpu: string;
  cores: number;
  memGB: number;
  node: string;
  /** Some group ran while the 1-minute load average was over half the cores: timing numbers are noisy. */
  busy: boolean;
  load1: number;
}

/** One group's outcome and provenance. */
export interface GroupStatus {
  /** Every measurement the group promised was taken, with no collection error. */
  ok: boolean;
  /** Why the group is not ok (empty when ok). */
  errors: string[];
  /** Ids the group promised but didn't produce. */
  missing: string[];
  /** When the group started (ISO). */
  when: string;
  commit: string;
  dirty: boolean;
  /** A hash of the uncommitted changes the group measured ("" for a clean tree). */
  tree: string;
  /** The 1-minute load average went over half the cores while the group ran. */
  busy: boolean;
  /** The highest 1-minute load average seen while the group ran. */
  load1: number;
  /** Runs folded into the group's values (`--repeat`). */
  repeat: number;
}

export interface MetricsRun {
  v: 2;
  when: string;
  /** The commit every group measured, or "mixed" (a merge of groups from different trees: see `status`). */
  commit: string;
  branch: string;
  dirty: boolean;
  tree: string;
  machine: Machine;
  groups: Group[];
  status: Partial<Record<Group, GroupStatus>>;
  /** The smallest repeat of any group. */
  repeat: number;
  metrics: Metric[];
  /** Free-form remarks: flags, raw report paths. Errors live in `status`. */
  notes: string[];
}

const ID = /^[a-z0-9][a-z0-9_.\-]*$/;

/** Problems with a run file (empty: valid). Checks every field a reader relies on, and that the statuses tell the truth. */
export function validateRun(r: unknown): string[] {
  const errs: string[] = [];
  if (!r || typeof r !== "object") return ["not an object"];
  const o = r as Partial<MetricsRun>;
  if (o.v !== SCHEMA_VERSION) errs.push(`v must be ${SCHEMA_VERSION} (got ${String(o.v)})`);
  for (const k of ["when", "commit", "branch", "tree"] as const) if (typeof o[k] !== "string") errs.push(`${k} must be a string`);
  if (typeof o.dirty !== "boolean") errs.push("dirty must be a boolean");
  if (!o.machine || typeof o.machine !== "object") errs.push("machine missing");
  if (typeof o.repeat !== "number" || !(o.repeat >= 1)) errs.push("repeat must be a number ≥ 1");
  const groups = Array.isArray(o.groups) ? o.groups : [];
  if (!Array.isArray(o.groups) || o.groups.some((g) => !(GROUPS as readonly string[]).includes(g))) errs.push("groups must list known groups");
  if (new Set(groups).size !== groups.length) errs.push("groups must not repeat");
  if (!Array.isArray(o.metrics)) return [...errs, "metrics must be an array"];
  const seen = new Set<string>();
  const perGroup = new Map<string, number>();
  o.metrics.forEach((m, i) => {
    const at = `metrics[${i}]${m && typeof m.id === "string" ? ` (${m.id})` : ""}`;
    errs.push(...validateMetric(m).map((e) => `${at}: ${e}`));
    if (m && typeof m.id === "string") {
      if (seen.has(m.id)) errs.push(`${at}: duplicate id`);
      seen.add(m.id);
    }
    if (m && typeof m.group === "string") {
      if (!groups.includes(m.group)) errs.push(`${at}: group ${m.group} is not in groups`);
      perGroup.set(m.group, (perGroup.get(m.group) ?? 0) + 1);
    }
  });
  const status = o.status && typeof o.status === "object" ? o.status : null;
  if (!status) return [...errs, "status must be an object"];
  for (const g of Object.keys(status)) if (!groups.includes(g as Group)) errs.push(`status.${g}: not in groups`);
  for (const g of groups) {
    const s = status[g];
    if (!s || typeof s !== "object") {
      errs.push(`status.${g} missing`);
      continue;
    }
    const at = `status.${g}`;
    if (typeof s.ok !== "boolean") errs.push(`${at}.ok must be a boolean`);
    if (!Array.isArray(s.errors) || s.errors.some((e) => typeof e !== "string")) errs.push(`${at}.errors must be strings`);
    if (!Array.isArray(s.missing) || s.missing.some((e) => typeof e !== "string")) errs.push(`${at}.missing must be strings`);
    for (const k of ["when", "commit", "tree"] as const) if (typeof s[k] !== "string") errs.push(`${at}.${k} must be a string`);
    if (typeof s.dirty !== "boolean" || typeof s.busy !== "boolean") errs.push(`${at}: dirty and busy must be booleans`);
    if (typeof s.load1 !== "number" || typeof s.repeat !== "number" || !(s.repeat >= 1)) errs.push(`${at}: load1 must be a number and repeat ≥ 1`);
    if (s.ok === true) {
      if (s.errors?.length) errs.push(`${at}: ok with errors`);
      if (s.missing?.length) errs.push(`${at}: ok with missing metrics`);
      if (!perGroup.get(g)) errs.push(`${at}: ok with no metrics`);
    }
    if (s.ok === false && !s.errors?.length) errs.push(`${at}: not ok must say why (errors)`);
    for (const id of Array.isArray(s.missing) ? s.missing : []) if (seen.has(id)) errs.push(`${at}: ${id} is both missing and present`);
  }
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
  if (o.gate !== undefined && (o.gate !== true || o.better !== "lower")) errs.push("gate must be true, on a lower-is-better count");
  return errs;
}

/** Every group the run asked for took every measurement it promised. */
export function runComplete(r: Pick<MetricsRun, "groups" | "status">): boolean {
  return r.groups.every((g) => r.status[g]?.ok === true);
}

/** Gates the run fails: `id = value` for each gate metric that isn't 0. */
export function failedGates(r: Pick<MetricsRun, "metrics">): string[] {
  return r.metrics.filter((m) => m.gate && m.value !== 0).map((m) => `${m.id} = ${m.value}`);
}

/**
 * Metrics the machine's load moves: timings and anything else with a run-to-run noise over 2 %.
 * Bytes, draw calls, triangles, request counts, resource counts and gates are not (noise ≤ 2 %).
 */
export const LOAD_SENSITIVE_NOISE = 0.02;
export function loadSensitive(m: Pick<Metric, "noise" | "gate">): boolean {
  return !m.gate && m.noise > LOAD_SENSITIVE_NOISE;
}

/** Two busy runs count as one session (comparable timings) when their groups started this close. */
export const SESSION_MINUTES = 30;

export type Verdict =
  | "better"
  | "worse"
  | "same"
  /** In a group only the after run has (nothing to compare with). */
  | "new"
  /** In the before run, absent from a group the after run measured: a measurement failed. */
  | "missing"
  /** Same id, different unit, direction or group: the two runs measure different things. */
  | "incompatible"
  /** A load-sensitive metric where either run was taken on a busy machine (not both in one session). */
  | "noisy"
  /** In the after run, in a group the before run left incomplete: the baseline can't judge it. */
  | "unbaselined";

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
  /** The spread this delta had to beat: max(noise × |a|, floor), using the larger noise of the two runs; 0 for gates. */
  threshold: number;
  verdict: Verdict;
  /** Why the verdict is not a plain better/worse/same. */
  why?: string;
}

/** Spread a change must beat to count, for a baseline value `a`. */
export function threshold(a: number, noise: number, floor = 0): number {
  return Math.max(Math.abs(a) * noise, floor);
}

export interface CompareOptions {
  /** Ids to leave out of the comparison (both sides). */
  skip?: RegExp;
  sessionMinutes?: number;
}

/**
 * Can the load-sensitive metrics of one group be compared between two runs? Both taken on a quiet
 * machine of the same kind, or both busy and within one session. Returns why not, or null.
 */
export function timingsComparable(a: MetricsRun, b: MetricsRun, g: Group, sessionMinutes = SESSION_MINUTES): string | null {
  const sa = a.status[g], sb = b.status[g];
  if (!sa || !sb) return "no status";
  if (a.machine.cpu !== b.machine.cpu || a.machine.cores !== b.machine.cores) return `different machines (${a.machine.cpu} ×${a.machine.cores} vs ${b.machine.cpu} ×${b.machine.cores})`;
  if (!sa.busy && !sb.busy) return null;
  const apart = Math.abs(Date.parse(sb.when) - Date.parse(sa.when)) / 60000;
  if (sa.busy && sb.busy && apart <= sessionMinutes) return null;
  const which = sa.busy && sb.busy ? `both busy but ${Math.round(apart)} min apart` : sa.busy ? `before was busy (load ${sa.load1})` : `after was busy (load ${sb.load1})`;
  return `${which}: a timing from a busy machine only compares with one from the same session`;
}

/**
 * Per-metric deltas between run `a` (before) and run `b` (after), in `a`'s order then `b`'s new ids.
 * Only groups `b` measured are compared: a metric of such a group that `b` lacks is `missing`.
 */
export function compareRuns(a: MetricsRun, b: MetricsRun, opts: CompareOptions = {}): Delta[] {
  const skip = opts.skip;
  const keep = (m: Metric) => !skip || !skip.test(m.id);
  const bm = new Map(b.metrics.filter(keep).map((m) => [m.id, m]));
  const comparable = new Map<Group, string | null>();
  const timing = (g: Group) => {
    if (!comparable.has(g)) comparable.set(g, timingsComparable(a, b, g, opts.sessionMinutes));
    return comparable.get(g)!;
  };
  const out: Delta[] = [];
  const base = (m: Metric) => ({ id: m.id, unit: m.unit, better: m.better, group: m.group });
  for (const ma of a.metrics.filter(keep)) {
    if (!b.groups.includes(ma.group)) continue; // not measured this time: no claim either way
    const mb = bm.get(ma.id);
    if (!mb) {
      out.push({ ...base(ma), a: ma.value, b: null, delta: null, rel: null, threshold: 0, verdict: "missing", why: b.status[ma.group]?.ok === false ? `after's ${ma.group} group failed` : undefined });
      continue;
    }
    const delta = mb.value - ma.value;
    const rel = ma.value !== 0 ? delta / Math.abs(ma.value) : null;
    if (ma.unit !== mb.unit || ma.better !== mb.better || ma.group !== mb.group) {
      const why = [ma.unit !== mb.unit && `unit ${ma.unit} → ${mb.unit}`, ma.better !== mb.better && `better ${ma.better} → ${mb.better}`, ma.group !== mb.group && `group ${ma.group} → ${mb.group}`].filter(Boolean).join(", ");
      out.push({ ...base(ma), a: ma.value, b: mb.value, delta, rel, threshold: 0, verdict: "incompatible", why });
      continue;
    }
    const gate = ma.gate || mb.gate;
    const noise = Math.max(ma.noise, mb.noise);
    const t = gate ? 0 : threshold(ma.value, noise, Math.max(ma.floor ?? 0, mb.floor ?? 0));
    if (loadSensitive({ noise, gate })) {
      const why = timing(ma.group);
      if (why) {
        out.push({ ...base(ma), a: ma.value, b: mb.value, delta, rel, threshold: t, verdict: "noisy", why });
        continue;
      }
    }
    const improved = ma.better === "lower" ? delta < 0 : delta > 0;
    const verdict: Verdict = delta === 0 || Math.abs(delta) <= t ? "same" : improved ? "better" : "worse";
    out.push({ ...base(ma), a: ma.value, b: mb.value, delta, rel, threshold: t, verdict });
  }
  const ids = new Set(a.metrics.map((m) => m.id));
  for (const mb of b.metrics.filter(keep)) {
    if (ids.has(mb.id)) continue;
    const sa = a.groups.includes(mb.group) ? a.status[mb.group] : undefined;
    const unbaselined = sa && (!sa.ok || sa.missing.includes(mb.id));
    out.push({ ...base(mb), a: null, b: mb.value, delta: null, rel: null, threshold: 0, verdict: unbaselined ? "unbaselined" : "new", why: unbaselined ? `before's ${mb.group} group was incomplete` : undefined });
  }
  return out;
}

export interface Outcome {
  /** 0: a conclusive comparison with nothing worse. 1: something worse, missing, incompatible, failed or a gate not 0. 3: inconclusive (busy machine, incomplete baseline). */
  code: 0 | 1 | 3;
  /** What made it 1. */
  failures: string[];
  /** What made it 3 (when nothing made it 1). */
  inconclusive: string[];
}

/** The verdict a hill climb acts on: only code 0 with some `better` delta is an improvement. */
export function compareOutcome(a: MetricsRun, b: MetricsRun, d: Delta[]): Outcome {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  for (const g of b.groups) {
    const s = b.status[g];
    if (!s?.ok) failures.push(`after's ${g} group is incomplete: ${(s?.errors ?? ["no status"]).join("; ").slice(0, 400)}`);
  }
  const count = (v: Verdict) => d.filter((x) => x.verdict === v);
  const list = (xs: Delta[]) => xs.slice(0, 8).map((x) => x.id).join(", ") + (xs.length > 8 ? ` and ${xs.length - 8} more` : "");
  if (count("worse").length) failures.push(`${count("worse").length} worse: ${list(count("worse"))}`);
  if (count("missing").length) failures.push(`${count("missing").length} missing from the after run: ${list(count("missing"))}`);
  if (count("incompatible").length) failures.push(`${count("incompatible").length} measured differently: ${list(count("incompatible"))}`);
  const gates = failedGates(b);
  if (gates.length) failures.push(`after fails ${gates.length} gate(s): ${gates.slice(0, 8).join(", ")}`);
  if (count("noisy").length) inconclusive.push(`${count("noisy").length} timing(s) not judged (busy machine): ${list(count("noisy"))}`);
  if (count("unbaselined").length) inconclusive.push(`${count("unbaselined").length} with no complete baseline: ${list(count("unbaselined"))}`);
  for (const g of a.groups) if (b.groups.includes(g) && a.status[g] && !a.status[g]!.ok) inconclusive.push(`before's ${g} group is incomplete: ${a.status[g]!.errors.join("; ").slice(0, 200)}`);
  return { code: failures.length ? 1 : inconclusive.length ? 3 : 0, failures, inconclusive };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Fold several runs of one group into one: each metric's median, and its noise raised to the observed
 * half-spread ((max − min) / 2 / |median|) when that is larger than the catalogue's. A gate keeps its
 * worst run (one failing run of three is a failure). `partial` lists ids some runs lack: a repeat is
 * complete only when every run measured every metric.
 */
export function foldRepeats(runs: Metric[][]): { metrics: Metric[]; partial: string[] } {
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
  const partial = order.filter((id) => byId.get(id)!.length < runs.length);
  const metrics = order.map((id) => {
    const ms = byId.get(id)!;
    const vals = ms.map((m) => m.value);
    const base = ms[0]!;
    if (base.gate) return { ...base, value: base.better === "lower" ? Math.max(...vals) : Math.min(...vals) };
    const med = median(vals);
    const half = (Math.max(...vals) - Math.min(...vals)) / 2;
    const observed = med !== 0 ? half / Math.abs(med) : 0;
    const out: Metric = { ...base, value: round(med), noise: round(Math.max(base.noise, observed), 4) };
    if (med === 0 && half > 0) out.floor = round(Math.max(base.floor ?? 0, half));
    return out;
  });
  return { metrics, partial };
}

/**
 * Several runs (e.g. one per group) into one file. Each group keeps its own status and provenance; the
 * top-level commit and tree are the common ones or "mixed". Refuses a group that two runs both carry,
 * and runs from different machines.
 */
export function mergeRuns(runs: MetricsRun[]): MetricsRun {
  if (!runs.length) throw new Error("nothing to merge");
  const seen = new Map<Group, number>();
  runs.forEach((r, i) => {
    const errs = validateRun(r);
    if (errs.length) throw new Error(`run ${i + 1} is not a metrics run:\n${errs.slice(0, 10).join("\n")}`);
    for (const g of r.groups) {
      if (seen.has(g)) throw new Error(`group ${g} is in run ${seen.get(g)! + 1} and run ${i + 1}: merge one run per group`);
      seen.set(g, i);
    }
    const m0 = runs[0]!.machine;
    if (r.machine.cpu !== m0.cpu || r.machine.cores !== m0.cores || r.machine.memGB !== m0.memGB) throw new Error(`run ${i + 1} is from another machine (${r.machine.cpu} ×${r.machine.cores})`);
  });
  const status: MetricsRun["status"] = {};
  for (const r of runs) for (const g of r.groups) status[g] = r.status[g];
  const all = Object.values(status) as GroupStatus[];
  const common = (xs: string[]) => (new Set(xs).size === 1 ? xs[0]! : "mixed");
  const merged: MetricsRun = {
    v: 2,
    when: runs.map((r) => r.when).sort().at(-1)!,
    commit: common(all.map((s) => s.commit)),
    branch: common(runs.map((r) => r.branch)),
    dirty: all.some((s) => s.dirty),
    tree: common(all.map((s) => s.tree)),
    machine: { ...runs[0]!.machine, busy: all.some((s) => s.busy), load1: Math.max(...all.map((s) => s.load1)) },
    groups: runs.flatMap((r) => r.groups),
    status,
    repeat: Math.min(...all.map((s) => s.repeat)),
    metrics: runs.flatMap((r) => r.metrics),
    notes: runs.flatMap((r) => r.notes),
  };
  const errs = validateRun(merged);
  if (errs.length) throw new Error(errs.join("\n"));
  return merged;
}

/** Only `groups` of a run (for merging part of one). */
export function pickGroups(r: MetricsRun, groups: Group[]): MetricsRun {
  for (const g of groups) if (!r.groups.includes(g)) throw new Error(`the run has no ${g} group`);
  const status: MetricsRun["status"] = {};
  for (const g of groups) status[g] = r.status[g];
  return { ...r, groups: [...groups], status, metrics: r.metrics.filter((m) => groups.includes(m.group)) };
}

/** Ids that are correctness gates (for files written before the schema had `gate`). */
const GATE_ID = /^(typecheck\.errors|balance\.checks\.failed|tests\.[a-z0-9_-]+\.failed|load\..+\.shaders_after_warmup|frame\..+\.shader_builds)$/;

/**
 * A schema v1 file as v2. v1 kept no completeness record, so every group is marked not ok: a v1 file
 * can be compared against, but never passes as a complete baseline.
 */
export function upgradeV1(r: any): MetricsRun {
  if (r?.v === SCHEMA_VERSION) return r as MetricsRun;
  if (r?.v !== 1) throw new Error(`unknown run file version ${String(r?.v)}`);
  const status: MetricsRun["status"] = {};
  for (const g of r.groups as Group[]) {
    status[g] = { ok: false, errors: ["recorded by schema v1, which kept no completeness record"], missing: [], when: r.when, commit: r.commit, dirty: r.dirty, tree: r.dirty ? "unknown" : "", busy: r.machine.busy, load1: r.machine.load1, repeat: r.repeat };
  }
  const metrics = (r.metrics as Metric[]).map((m) => {
    if (!GATE_ID.test(m.id)) return m;
    const { floor: _floor, ...rest } = m;
    return { ...rest, noise: 0, gate: true as const };
  });
  return { ...r, v: 2, tree: r.dirty ? "unknown" : "", status, metrics };
}

export function round(v: number, digits = 3): number {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

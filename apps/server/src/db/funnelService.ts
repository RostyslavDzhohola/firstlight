// The game server's side of the funnel's worker (D-sec3-1, review round three #1): the reports for
// /stats, the daily housekeeping (error pruning and the fold into funnel_day) and the boot-time count
// behind today's caps run in a worker thread with its own connection to game.db (db/funnelWorker.ts).
// Here the game's thread only posts a job and awaits the answer, with a timeout; it never reads a
// funnel table in bulk. One job of each kind at a time: asking again while one runs shares its answer,
// so a busy /stats can't pile jobs up. A job that outlives its timeout is left to finish (its answer
// is dropped); a worker that dies is started again on the next job.
//
// Started by auth/accounts.ts when the funnel is on (FUNNEL_ENABLED, default on) and game.db is a
// file; /stats finds it by its database (funnelServiceFor). While it runs, the worker checkpoints the
// WAL and the game's connection doesn't (wal_autocheckpoint 0): a commit on the game's thread never
// copies megabytes the worker's housekeeping wrote. A worker that stops unasked after running a while
// is started again; one that dies at start waits for the next job.

import { Worker } from "node:worker_threads";
import type { Db } from "./game-db.ts";
import { closeFunnel, flushFunnel, primeFunnelBudget, withLimits, type FunnelWindows } from "./funnel.ts";
import type { ReportWindows } from "./funnelReport.ts";
import { FUNNEL_LIMITS } from "./funnelRules.ts";
import type { FunnelAnswer, FunnelJob } from "./funnelWorker.ts";

type Op = FunnelJob["op"];
/** A job as posted, without its id. */
type JobArgs<O extends Op> = O extends Op ? Omit<Extract<FunnelJob, { op: O }>, "id"> : never;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => no(new Error(`funnel ${what}: no answer within ${Math.round(ms / 1000)} s (the worker goes on)`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export class FunnelService {
  readonly db: Db;
  private readonly path: string;
  private worker: Worker | null = null;
  private seq = 0;
  private closed = false;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  private readonly running = new Map<Op, Promise<unknown>>();
  /** How long the last job of each kind took in the worker (ms), for /stats and the benchmark. */
  readonly lastJobMs: Partial<Record<Op, number>> = {};
  private readonly autoCheckpoint: number;

  constructor(db: Db, path: string) {
    this.db = db;
    this.path = path;
    this.autoCheckpoint = db.pragma("wal_autocheckpoint", { simple: true }) as number;
    this.spawn();
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./funnelWorker.ts", import.meta.url), { workerData: { path: this.path } });
    w.unref(); // never keeps the process alive
    if (this.db.open) this.db.pragma("wal_autocheckpoint = 0"); // the worker checkpoints (funnelWorker.ts)
    w.on("message", (a: FunnelAnswer) => {
      const h = this.waiting.get(a.id);
      if (!h) return;
      this.waiting.delete(a.id);
      if (a.ok) h.ok(a.result);
      else h.no(new Error(a.error ?? "funnel job failed"));
    });
    const fail = (err: Error) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const h of this.waiting.values()) h.no(err);
      this.waiting.clear();
    };
    const born = performance.now();
    let why = "";
    w.on("error", (err) => {
      why = err.message;
      fail(err);
    });
    w.on("exit", (code) => {
      fail(new Error(`funnel worker stopped (${code})`));
      if (this.closed) return;
      // It keeps the WAL short, so one that ran a while is started again; one that died at once
      // (a broken install) is not looped: the next job tries again.
      console.warn(`funnel worker stopped (${why || `exit ${code}`})${performance.now() - born > 10_000 ? "; starting it again" : ""}`);
      if (performance.now() - born > 10_000) setTimeout(() => this.closed || this.spawn(), 1_000).unref();
      else if (this.db.open) this.db.pragma(`wal_autocheckpoint = ${this.autoCheckpoint}`); // until a worker runs again
    });
    this.worker = w;
    return w;
  }

  /** Post a job (or share the one of its kind that is running) and wait at most `timeoutMs` for its answer. */
  private call<T>(job: JobArgs<Op>, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("funnel worker closed"));
    let run = this.running.get(job.op);
    if (!run) {
      const id = ++this.seq;
      const t0 = performance.now();
      run = new Promise((ok, no) => {
        this.waiting.set(id, { ok, no });
        this.spawn().postMessage({ ...job, id });
      }).finally(() => {
        this.running.delete(job.op);
        this.lastJobMs[job.op] = performance.now() - t0;
      });
      run.catch(() => {}); // a caller that timed out no longer listens
      this.running.set(job.op, run);
    }
    return withTimeout(run as Promise<T>, timeoutMs, job.op);
  }

  /** Boot: add what today already holds to today's caps (so a restart doesn't reset them). */
  async prime(now = Date.now()): Promise<void> {
    const counts = await this.call<Parameters<typeof primeFunnelBudget>[1]>({ op: "today", now }, FUNNEL_LIMITS.reportTimeoutMs);
    primeFunnelBudget(this.db, counts, now);
  }

  /** What /stats shows: the worker's report, with today's caps and the queue from this thread. */
  async windows(now = Date.now()): Promise<FunnelWindows> {
    flushFunnel(this.db); // one bounded attempt: rows queued in the last second may show on the next load
    const r = await this.call<ReportWindows>({ op: "windows", now, limits: { retentionDays: FUNNEL_LIMITS.retentionDays, errorRetentionDays: FUNNEL_LIMITS.errorRetentionDays } }, FUNNEL_LIMITS.reportTimeoutMs);
    return withLimits(r, this.db, now);
  }

  /** The daily housekeeping: old error reports pruned, old cohort days folded (in small transactions, in the worker). */
  housekeep(now = Date.now(), timeoutMs = 60 * 60_000): Promise<{ pruned: number; folded: number; maxHoldMs: number; maxHoldWallMs: number; slices: number }> {
    flushFunnel(this.db);
    const l = FUNNEL_LIMITS;
    return this.call({ op: "housekeep", now, limits: { retentionDays: l.retentionDays, errorRetentionDays: l.errorRetentionDays, sliceRows: l.workerSliceRows, pauseMs: l.workerPauseMs, busyMs: l.workerBusyMs } }, timeoutMs);
  }

  /** Shutdown: the queue's final flush (one deadline, closeFunnel), then the worker stops (a job it was running is rolled back and redone next time). */
  async close(deadlineMs = FUNNEL_LIMITS.closeDeadlineMs): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    services.delete(this.db);
    await closeFunnel(this.db, deadlineMs);
    const w = this.worker;
    this.worker = null;
    for (const h of this.waiting.values()) h.no(new Error("funnel worker closed"));
    this.waiting.clear();
    await w?.terminate();
    if (this.db.open) this.db.pragma(`wal_autocheckpoint = ${this.autoCheckpoint}`);
  }
}

const services = new WeakMap<Db, FunnelService>();

/** Start the funnel's worker for `db` (a file: the worker opens its own connection to `path`). */
export function startFunnelService(db: Db, path: string): FunnelService {
  const s = new FunnelService(db, path);
  services.set(db, s);
  return s;
}

/** The running funnel worker for this database, if any (/stats). */
export function funnelServiceFor(db: Db): FunnelService | null {
  return services.get(db) ?? null;
}

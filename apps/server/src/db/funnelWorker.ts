// The funnel's worker thread (D-sec3-1): its own connection to game.db, and every funnel job that reads
// or rewrites whole tables: the /stats report, the daily fold into funnel_day, the error pruning, and
// today's stored counts at boot (db/funnelReport.ts). The game server's thread only posts a message
// and awaits the answer (db/funnelService.ts), so none of it can stall a room, whatever the size of
// the tables or the state of the database. Jobs run one after another; each answer says how long it
// took (`ms`).

import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { DAY } from "./funnelRules.ts";
import { foldFunnel, pruneErrors, reportWindows, todayCounts, type RetentionLimits } from "./funnelReport.ts";

/** A job from the game's thread. */
export type FunnelJob =
  | { id: number; op: "windows"; now: number; limits: RetentionLimits }
  | { id: number; op: "today"; now: number }
  | { id: number; op: "housekeep"; now: number; limits: RetentionLimits & { sliceRows: number; pauseMs: number; busyMs: number } };

/** The answer: the result, or the error; and how long the job took here. */
export interface FunnelAnswer {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  ms: number;
}

const port = parentPort;
if (port) {
  const db = new Database((workerData as { path: string }).path, { fileMustExist: true });
  // Waiting for a lock is fine here (the game's thread never waits on this one); housekeeping sets its own.
  db.pragma("busy_timeout = 5000");
  port.on("message", (job: FunnelJob) => {
    const t0 = performance.now();
    let answer: FunnelAnswer;
    try {
      let result: unknown;
      if (job.op === "windows") result = reportWindows(db, job.now, job.limits);
      else if (job.op === "today") result = todayCounts(db, job.now);
      else {
        db.pragma(`busy_timeout = ${Math.max(0, Math.floor(job.limits.busyMs))}`);
        const opts = { sliceRows: job.limits.sliceRows, pauseMs: job.limits.pauseMs };
        const pruned = pruneErrors(db, job.limits.errorRetentionDays * DAY, job.now, opts);
        const folded = foldFunnel(db, job.now, { ...opts, retentionDays: job.limits.retentionDays });
        result = { pruned, folded };
      }
      answer = { id: job.id, ok: true, result, ms: performance.now() - t0 };
    } catch (err) {
      answer = { id: job.id, ok: false, error: String((err as Error)?.message ?? err).slice(0, 200), ms: performance.now() - t0 };
    }
    port.postMessage(answer);
  });
}

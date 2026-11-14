# Fourth look: the third security fix round (`night/fix-sec3` at `2e96f91b`), GPT-6.1 Sol, 2026-11-14

**Verdict: safe with named conditions.** The agent gateway and the dev sign-in code pass. Deploy with the
funnel off (`FUNNEL_ENABLED` unset or `0` in production: D-ship-12 makes off the production default); the
enabled funnel is not yet safe.

## Round-three findings

| # | Finding | Status |
|---|---|---|
| 1 | reports and rollup stall the simulation | partly closed: the scans run in a worker and the full-cap benchmark passes, but see finding 1 below |
| 2 | dev key retrievable through a headerless proxy | closed (the endpoint is gone; the key arrives in a URL fragment; a production bundle holds neither) |
| 3 | shutdown repeats the lock timeout per row | closed |
| 4 | visit replacement discards a new step | closed |
| 5 | scrubbing erases diagnostic codes | closed |
| 6 | quadratic bracket cleanup | closed |

## Remaining findings

1. **Blocker for enabling the funnel, `apps/server/src/db/funnelReport.ts:399`, `:180`: client-supplied
   grouping values defeat the fold's lock bound and the report's size bound.** Tutorial ids are bounded
   per visit, not across visits; each day's aggregate writes are one transaction. One valid-sized day
   (2,500 visits × 15 distinct tutorial ids, 40,000 rows): a 1.99 MB report, 94.6 ms of main-thread CPU to
   receive it, and a fold transaction of 452 ms CPU / 4,465 ms wall during which a game write waited
   4,205 ms (loaded Mac). Bound every client-controlled grouping dimension to known values plus "other",
   bound report output, benchmark distinct values, stage large aggregates in bounded transactions.
2. **Should-fix, `apps/server/test/funnel-stall.test.ts:133`, `:156`:** the benchmark's CPU interval
   leaves out the simulated game save, the final interval and a check that ticks were observed.
3. **Should-fix, `apps/server/src/db/funnelService.ts:26`, `:92`:** a timeout does not recover a worker that
   never answers (its jobs stay shared for good, checkpoint ownership stays with it).
4. **Should-fix, `apps/server/src/db/funnel.ts:399`:** `moveFunnel()` on account linking still writes with
   the funnel off.

## Checked and sound

Own WAL connection without lock inversion; early worker death restores checkpoints; no respawn loop;
job coalescing bounds queued work; the fold's ascending days and atomic totals-plus-marker survive an
injected failure without skipping or double counting; every caller awaits `Accounts.close()`; the `.ts`
worker loads under plain Node 24.19 and passes 168 erasable-TypeScript checks. The dev key: fragments
never reach HTTP or referrers, `replaceState` removes it from the current history entry, storage is per
port. Off: ingest returns before parsing, hooks are guarded, no worker or timer. 252 tests across eight
files. The `/stats` identity write and the session and guest pruning do not block a funnel-off launch.

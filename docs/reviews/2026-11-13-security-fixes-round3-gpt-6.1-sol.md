# Third look: the second security fix round (`night/fix-sec2`, `a40fe4bd..4390f99e`), GPT-6.1 Sol, 2026-11-13

**Verdict: not yet.** The write-path fixes hold, but funnel reporting and housekeeping still stall the
game thread at volumes below the documented caps.

## Round-two findings

| # | Finding | Status |
|---|---|---|
| 1 | public development sign-in codes | partly closed (the key itself can be fetched through a headerless same-host proxy in front of Vite: finding 2) |
| 2 | unbounded, uncancellable legacy joins | closed |
| 3 | IPv6 URLs keep credential paths | closed |
| 4 | quadratic email scrubbing | closed (a bounded quadratic step remains: nit 6) |
| 5 | funnel storage blocks the simulation | partly closed (writes return in 0.4–2.7 ms under a lock; reports and the rollup do not: finding 1) |
| 6 | uncertain model usage released | closed |
| 7 | flush failure loses acknowledged steps | closed |
| 8 | rollup forgets returning subjects | closed |
| 9 | sent steps outlive their visit | partly closed (a same-page change of visit loses a new step: finding 4) |

## Remaining and new findings

1. **Blocker, `apps/server/src/db/funnel.ts:836`, `:639`: reports and the rollup still stop every room.**
   One `funnelWindows` call over 40,000 visit rows used 892 ms of CPU; at 160,000 rows the report took
   49.2 s and folding four cohort days 41.4 s of wall time on a heavily loaded Mac (not production
   estimates). Both sizes are below the retention cap. `/stats` calls the reports synchronously and the
   daily housekeeping calls the rollup by itself. Move both to a worker connection or keep incremental
   aggregates; caching `/stats` alone does not fix housekeeping.
2. **Should-fix, `apps/client/src/net/devKeyGuard.ts:14`: the headerless-proxy weakness moved to key
   retrieval.** `localPage` is true for loopback, `Host: localhost:5173` and no forwarding or Fetch
   Metadata headers, so a remote non-browser caller through a proxy that exposes Vite can fetch the key.
   Direct LAN access and foreign-origin browser fetches are refused; production builds hold neither key
   nor fetch. Keep key delivery behind an authenticated local channel, or forbid exposing Vite while
   dev-code retrieval is on.
3. **Should-fix, `db/funnel.ts:370`: shutdown repeats the lock timeout per row** (5,000 queued rows under
   a persistent lock: about seven hours). One overall deadline for the final flush; count the rest lost.
4. **Should-fix, `apps/client/src/net/beacon.ts:245`: a step made during a visit replacement is
   discarded** (acknowledge Play for visit A, expire its token, queue World, issue visit B: only A's Play
   is posted). Assign new events to a visit only after renewal resolves; add a same-instance test.
5. **Should-fix, `packages/shared/src/net/scrub.ts:105`: arbitrary key prefixes erase diagnostic codes**
   (`HTTP status_code=INVALID_ARGUMENT`, `shader code: WGSLValidationError`). Recognise explicit
   credential keys, not any word ending in a sensitive suffix.
6. **Nit, `scrub.ts:77`: URL cleanup is still quadratic** inside the 4,096-character bound (about 5 ms).

## Checked and sound

109 tests across eight files. Sliced transactions keep queue order; a failed slice rolls back before its
retry; queue memory and retries are bounded. Removing the loopback exemption does not collapse hosted
gateway joins onto one address (the gateway forwards each caller's address); in-process helpers opt in;
load-test bots keep their budgets; the journeys use normal limits.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |

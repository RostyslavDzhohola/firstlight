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
| 1 | Reports, housekeeping and the boot-time count run in a worker thread with its own connection to game.db (`db/funnelWorker.ts`, `db/funnelService.ts`); `/stats` awaits it with a timeout. One linear pass over `funnel_step` serves every window (the cohort join was quadratic). The fold writes each day's totals and a `meta:folded` watermark in one transaction, then deletes or marks rows in 200-row transactions with pauses (resumable, never double-counted). The budget never queries on the game's thread. The worker checkpoints the WAL; the game's connection doesn't while it runs (D-sec3-1). `funnel-stall.test.ts` fills 2.7 M rows and measures the game thread's CPU between 2 ms ticks through the day's first write, `/stats`, housekeeping and shutdown, free and locked: 2–14 ms (bound 50 ms); the old synchronous report on the same data took 15.7 s (D-sec3-2). | `c055c6e2`, `bb15ab7c`, `be5346ce` |
| 2 | No request returns the dev key: Vite prints a link with the key in its URL fragment in the developer's terminal, and the page keeps it (`net/devKey.ts`); `/@firstlight/dev-key` and its guard are gone. A build holds neither key nor fetch (D-sec3-6). | `bf24dffd` |
| 3 | `closeFunnel`: the timer's bounded, lock-free slices until one overall deadline (2 s); the rest counted lost and logged once; `Accounts.close()` async (D-sec3-4). Test: 5,000 rows under a held lock end at the deadline, one warning. | `bb15ab7c` |
| 4 | A step made without a live token waits for the renewal's answer and joins that visit once (D-sec3-5). Tests: the review's same-instance probe, a renewal to the same id, a renewal that fails first. | `b06bd81b` |
| 5 | `CREDENTIAL_KEYS`: an explicit list, never a longer word or a bare `code`/`key` (D-sec3-7). Tests: the review's two examples and more. | `51ede812` |
| 6 | `urlEnd` finds the first `[` once (linear). Test: a URL ending in 4,000 `]` in under 2 ms. | `51ede812` |

Also: `FUNNEL_ENABLED=0` switches the funnel off (204s, nothing stored, no timer or worker, `/stats` says so; the page takes 204 as "not now"; D-sec3-3), tests for both states (`bb15ab7c`, with the 204 handling in `b06bd81b`). The Privacy card's retention line was stale since D-sec2-6 (`be5346ce`).

Left on the game's thread, each bounded: the queue's flush (at most one 200-row slice or 4 ms per turn, never a lock wait); the ingest's primary-key lookups and its scans of the queue (5,000 entries at most); the guest-to-account move inside the link transaction (one account's rows); posting jobs and receiving the report. Not the funnel's but seen while measuring: the admin check in front of `/stats` writes the account's last visit (`ensureAccount`) and waits up to 5 s for a lock like every other game write, and the daily `pruneSessionLog` and guest pruning still run on the game's thread.

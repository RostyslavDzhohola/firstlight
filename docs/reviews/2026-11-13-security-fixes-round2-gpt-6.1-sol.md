# Second review: the three security fix passes (`night/integration` at `eb717071`), GPT-6.1 Sol, 2026-11-13

**Verdict: do not merge.** Several first-round findings are only partly closed, and the fixes add privacy,
accounting and reliability problems.

## First-round findings

| Area | Finding | Status |
|---|---|---|
| Gateway | 1 unbounded queued work | partly closed (legacy join waiters bypass the bound: finding 2) |
| Gateway | 2 model budget overspend | partly closed (failed responses release tokens that may be spent: finding 6) |
| Gateway | 3 concurrent legacy joins orphan seats | closed |
| Gateway | 4 legacy cancellation ignored | partly closed (actions cancel, joins do not) |
| Gateway | 5 residents join before the people budget | closed |
| Dev codes | 1 publicly exposed development endpoint | partly closed (a same-host proxy with no forwarding headers passes: finding 1) |
| Funnel | 1 unbounded durable writes | partly closed (flushes still block the simulation thread and lose accepted writes on failure) |
| Funnel | 2 fabricated visits and KPIs | partly closed (retention loses subject identity: finding 8) |
| Funnel | 3 reports retain secrets | partly closed (an IPv6 URL's credential path survives) |
| Funnel | 4 keypad answer shipped as text | closed in source (bundle not rebuilt) |
| Funnel | 5 automation counted as people | closed for the implemented signals |
| Funnel | 6 missing privacy disclosure | closed |
| Funnel | 7 failed delivery loses steps | partly closed (acknowledged before it is stored) |
| Funnel | 8 unavailable storage splits visits | closed |
| Funnel | 9 returning characters counted as new | closed |

## Remaining and new findings

1. **Blocker, `apps/server/src/auth/ip.ts:109`: a headerless local proxy still exposes sign-in codes.** A
   reverse proxy that connects over loopback, sets the upstream Host to `localhost:2567` and adds no
   forwarding headers passes `localDevRequest`; the helper also accepts an unrelated Origin. Confirmed by
   calling the real guards (the play-limit exemption passes too). Header absence cannot prove local
   provenance: require a development credential only local tooling has, or move code retrieval to a
   local channel; apply the same distinction to the play exemption.
2. **Should-fix, `apps/server/src/agents/mcpHttp.ts:120`: legacy joins form an uncapped, uncancellable
   waiting queue.** With the seat queue limit at four, twelve concurrent joins all stayed pending and
   cancelling freed none; cancelling the first join still produced a live seat. Reject further joins
   while one is pending, honour cancellation, close a seat whose join was cancelled.
3. **Should-fix, `packages/shared/src/net/scrub.ts:52`: IPv6 URLs bypass credential-path scrubbing**
   (`https://[::1]/reset/shortsecret?token=secret` kept its path secret).
4. **Should-fix, `scrub.ts:58`: email scrubbing is quadratic** on a long string without `@` (16,000
   characters: about 780 ms), on public ingestion and on the client before truncation. Bound the input
   first; scan around `@`.
5. **Should-fix, `apps/server/src/db/funnel.ts:272`: the batched writer still blocks the game thread** (up
   to 5,000 synchronous inserts in one callback; a locked database can wait the five-second busy
   timeout). Source-confirmed, not measured.
6. **Should-fix, `tools/agent/resident-talk.ts:242`: uncertain model usage is released as unspent** (a
   timeout or failed read drops the output allowance). Keep the full reservation unless real usage is known.
7. **Should-fix, `db/funnel.ts:278`: flush failures lose acknowledged steps without a count in `/stats`.**
8. **Should-fix, `db/funnel.ts:510`: the rollup forgets subjects that can still return** (visits renew for
   28 days, raw rows are kept 21): after folding, a repeated Play moved all-time gets-in from 1/1 to 1/2.
9. **Should-fix, `apps/client/src/net/beacon.ts:150`: acknowledged steps outlive their visit** (the
   sent-step key is browser-wide, so a new visit's Play is suppressed).

## Checked and sound

104 tests passed across eight files run one at a time. Token tamper, length, expiry, stable key across
a restart and rejection after rotation all behave. Production requires the auth secret. Limiter maps and
pending-write memory are bounded; daily counters rebuild from stored rows after a restart; migration 12
keeps migration 11's rows; an immediate second rollup does nothing. Anonymous callers can still request
person visits and send false Play claims, lowering gets-in without joining: the caps bound it and
`/stats` warns when a cap is hit, but not below it.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | A code is readable only with the run's key: the root `pnpm dev` (`tools/dev.ts`) makes `DEV_SIGNIN_KEY` per run for the server and Vite; Vite hands it only to this machine's pages (never inside a module); the server compares in constant time and without a strong key doesn't mount the route; Origin must be absent or ours; opt-in, production refusal, `localDevRequest` and no-store kept. A fresh production build holds neither key nor fetch (tested). The play limits' loopback exemption is removed from running servers: it is the in-process tests' explicit `loopbackExempt`, never set by `main.ts` (D-sec2-1). Tests: the headerless-proxy probe (no key, wrong keys, foreign Origin, rebound Host), no key configured, the build scan, the proxy probe against the play limits. | `b13ea695`, `43574950` |
| 2 | One legacy join in flight per session, others refused at once ("join in progress"); `gateway.join` takes the abort signal on every face and closes the seat of a cancelled or hung-up join (D-sec2-2). Tests: twelve joins behind one in flight answer at once, cancelling the first leaves no seat, a hung-up legacy join leaves no seat. | `037bcbd2` |
| 3 | Any `scheme://` run is a URL (IPv6 brackets, userinfo, ports, any case, stacked percent-encoding) reduced to its origin; every run with a slash, with or without a scheme, loses its query and what follows a sensitive segment; `access_token`-style keys redacted (D-sec2-3). | `0ceb37af` |
| 4 | Input cut to 4,096 characters (stacks 8,192, lines 480) before any pattern, dropping the split word; every pattern anchored to run boundaries. A 100,000-character string of 16 hostile shapes (`x…`, `@…`, `a@a@…`, `://…`, `eyJ…`, spaces, …) takes under 3 ms on a quiet machine through every entry point; the old code did not finish in 200 s. | `0ceb37af` |
| 5 | Flush in 200-row transactions with `busy_timeout 0`, 4 ms budget per attempt (at least one slice), a lock stops the attempt and backs off (D-sec2-4). Measured with another connection holding the write lock: attempts 2–5 ms (old: 5,387 ms), longest event-loop stall about 9 ms while locked and while writing 5,000 rows. | `9e500c5a`, `9016d56f` |
| 6 | A call keeps its whole reservation unless the provider reports usage; each reported part settles (D-sec2-5). Test: 500, 429, timeout, network, unreadable body and missing usage all keep it. | `7561f68d` |
| 7 | A row that can't be written stays queued for 12 attempts (about four minutes of backoff), then is dropped; retries, drops and the last error are counted and shown on `/stats`; only shutdown waits for locks. A guest's queued rows move to its account in memory. Test: a database that stays locked drops after the bounded attempts and `/stats` shows it. | `9e500c5a` |
| 8 | Raw rows kept longer than a visit can act (`VISIT_LIFE_DAYS` = 30, the rollup never uses less; default 31); a folded account keeps its rows marked `folded` (migration 13) until the account is deleted (D-sec2-6). Tests: the review's repeated-Play probe up to the visit's last live moment (gets-in stays 1/1), a misconfigured retention, and a mission after an account's day was folded (no figure moves, its first join stays known). | `9016d56f` |
| 9 | The beacon's state is `{visit, sent, pending}` for one visit id: a renewal keeps it, a new visit starts with nothing sent, steps made before the page knows its visit join it, an old visit's pending steps never move (D-sec2-7). | `eb1d2864` |

### Left for a third look (attack pass after these fixes)

- **The funnel reports and the rollup still run on the game's thread.** `funnelWindows` (every `/stats`
  load) runs three `funnelReport`s, each a `GROUP BY subject` over the whole raw table, and the daily
  `rollupFunnel` does the same per folded day. At the caps (about 1.3 M visit rows plus account rows)
  that is a scan of seconds that stalls every room. Writes no longer wait; reads still do. Fix: read
  from a second read-only connection in a worker, or keep running aggregates.
- Fixed in this pass: the first funnel write of a UTC day counted today's rows (four `COUNT(*)`, up to
  80,000 rows) inside whatever called it, possibly a room tick. A running server now starts the new day
  from its own queue; only the first write after a start counts.
- **Exposing `pnpm dev` itself** (both the Vite dev server and the API through a proxy) still hands the
  key to any page the proxy serves: a dev code is an authentication bypass by design. `pnpm dev` is
  for this machine only; say so wherever sharing a dev server is described.
- **Account rows kept until the account is deleted** grow with guests until pruning (at most 40,000
  account rows a day for 30 days of inactivity), then go with the next rollup.

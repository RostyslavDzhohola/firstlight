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
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |

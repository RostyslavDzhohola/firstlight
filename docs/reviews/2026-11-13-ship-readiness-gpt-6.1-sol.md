# Review: ship-readiness lane (`night/ship` at `b76729c3`), GPT-6.1 Sol, 2026-11-13

**Verdict: do not merge.** Anonymous ingestion can grow the game database without bound and falsify the
launch KPIs; error reports also retain URL secrets.

## Findings

1. **Blocker, `apps/server/src/ops/funnel.ts:83`: unbounded durable writes into the game database.** A
   caller can keep inventing visits and insert 16 rows a request: the limits allow 691,200 rows a day from
   one address, 69,120,000 a day globally. Funnel rows have no retention or cap; each insert is a
   synchronous write to the SQLite file the game uses, and growing tables make `/stats` slower. Confirmed:
   a small local batch inserted 400 tutorial rows (the latency effect is inferred). A 5 KB
   `application/json` request was accepted past the advertised 4 KB limit (the global JSON parser runs
   first). Add a conservative row and write budget, bounded retention or aggregation, writes batched off
   the simulation's critical path, and the body limit enforced before the global parser.
2. **Should-fix, `ops/funnel.ts:85`: arbitrary visits and steps can falsify or suppress KPIs.** Visit ids
   are syntax-checked, not issued or bound by the server. Anonymous callers can fabricate `world`, timing,
   tutorial and crash events; a known visit can be given a step marked `test` with any `x-loadtest-secret`
   value, which removes the whole visit from the people cohort. Confirmed: fabricated events gave 200%
   gets-in, target met. Server-issued visit credentials with immutable classification, validated
   transitions, conversion computed from subjects that reached both steps, client claims kept apart from
   server-verified outcomes.
3. **Should-fix, `ops/funnel.ts:115`: error reports retain secrets and personal content.** The reused
   redactor misses arbitrary URL tokens, reset-token path segments and encoded emails; the client sends
   raw messages, stacks and JSON-stringified rejection objects. Confirmed: URL path and query secrets and
   an encoded email reached SQLite, kept 90 days. Sanitise before sending and again on ingestion: drop URL
   queries, fragments and sensitive paths, restrict stack frames, never serialise arbitrary rejections.
4. **Should-fix, `apps/server/test/egg-rules.test.ts:24`: #41 still leaves the keypad answer in client
   code** (`apps/client/src/world/QuestWorld.ts:481`, `:486`); the guard scans only `packages/shared`.
   Remove the literal from shipped JavaScript, keep the visual clue through an asset, extend the guard to
   client sources and the production output.
5. **Should-fix, `apps/client/src/net/beacon.ts:180`: automated and test-account visits default to
   people.** The beacon ignores `?e2e`, `navigator.webdriver` and test or agent identity. Honour explicit
   automation flags; bind account classification on the server.
6. **Should-fix, `apps/client/src/home/datafast.ts:53`: first-party collection can have no privacy
   disclosure.** Without DataFast, `privacyText()` is null and the Privacy link disappears while the
   beacon stores a persistent id and sends events. Always disclose it; state its controls accurately (it
   honours neither Do Not Track nor `fl.noAnalytics` today).
7. **Should-fix, `beacon.ts:100`: a temporary ingestion failure loses first steps for good.** Steps are
   marked sent before delivery. Bounded pending delivery with acknowledgement; the silent 204 for rejected
   data prevents a reliable acknowledgement today.
8. **Should-fix, `beacon.ts:47`: unavailable storage splits one page into several visits.** Cache the
   generated id in memory.
9. **Should-fix, `apps/server/src/world/funnel.ts:66`: returning characters enter the "new character"
   cohort.** Every join records a first funnel join, including characters from before the deploy. Mark
   eligibility at real character creation.

## Checked and sound

Server account milestones come from authoritative paths; public ingestion cannot write `u:` subjects;
replays cannot overwrite a subject and step. Visit format, step allowlist, numeric bounds, field lengths
and bounded limiter memory exist. `/stats` HTML and JSON share the admin gate; JSON is `no-store`;
strings are escaped under a restrictive CSP (no stored XSS found). Migration 11 is additive and
transactional; the previous build skips the newer version and leaves the tables. The beacon is
asynchronous and does not hold up the game start. Tests: funnel 10/10, beacon 3/3, egg-rules 2/2, boot
14/14.

## Not checked

Browser journeys, clips, devices, the production bundle, a production-sized migration or rollback, game
loop latency under sustained ingestion. The background-tab journey covers 60 s, not ten minutes.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | Visits issued per address (10/10 min) and per day (5,000); ≤ 30 rows a visit; daily budgets for visit rows, account rows and error reports; one bounded queue flushed once a second in a transaction (off the request and the room tick); raw rows 21 days then folded into `funnel_day` (migration 12), errors 30 days; 4 kb bodies for every content type, mounted before `express.json` (D-ship-7). Tests: one-address and many-address floods stay under the caps, 413 for five content types on all three routes, writes queued, rollup | `43ea6148` |
| 2 | Server-issued signed visit tokens with the kind fixed at issue (`auth/visitToken.ts`); steps refused (401) without a live token; the room records the visit's `join` from the token `/api/play` carries; every KPI counts subjects that reached both steps, with a server/page source, the headline gets-in on the server's join (D-ship-6, D-ship-8). Tests: made-up ids and forged tokens refused, the 200 % probe gives 0/1, a later secret header can't reclassify a visit, a real join counts | `43ea6148`, `bd7c4058` |
| 3 | One shared scrubber (`packages/shared/src/net/scrub.ts`) run by the beacon before sending and by the ingest on arrival: URLs reduced to origin and script file, sensitive path segments, plain and encoded emails, JWT/bearer/key=value/long tokens removed, five frames, rejections reported by type only (D-ship-9). Tests: the review's URL path and query tokens, encoded email and rejected object, through the client and through the server | `43ea6148`, `bd7c4058` |
| 4 | The mirror room's clue is two PNGs drawn from the server's rule (`tools/eggs/mirror-clue.ts`), loaded as files; the answer is gone from client sources and the bundle; the guard scans every client text file and a fresh `vite build` (`egg-rules.test.ts`, `pnpm check:eggs`) (D-ship-11) | `149f1299` |
| 5 | `navigator.webdriver`, `?e2e` and `?bench` ask for a test visit; only the real `LOADTEST_SECRET` makes one; the visit's join takes the stricter of its kind and the player's (an agent's or our test account's) | `43ea6148`, `bd7c4058` |
| 6 | The Privacy link and card always show our own funnel, with or without DataFast; the beacon is off with Do Not Track, Global Privacy Control or `fl.noAnalytics`, and the card says so (D-ship-10) | `441d5f73`, `bd7c4058` |
| 7 | Steps wait in a bounded pending list (kept across pages) until the server's answer names them; failed, 401, 429 and 5xx posts are retried with a backoff (at most six), leftovers go on the next page; the server answers `{done}` | `bd7c4058` |
| 8 | The visit token is cached in memory as well as storage: one visit request per page when storage throws | `bd7c4058` |
| 9 | The room marks `charCreated` when a join makes the character; the account cohort needs that `new` step, so returning characters never count as new (D-ship-8). Test: a character saved before the join is not new, a fresh one is | `43ea6148` |

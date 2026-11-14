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
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |

# Review: agent gateway lane (`night/agents` at `6cdb1f40`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** The gateway has an unbounded action queue, and the resident model's hard
budget can be exceeded.

## Findings

1. **Blocker, `tools/agent/tools.ts:88`, `apps/server/src/agents/gateway.ts:215`: unbounded queued work.**
   Every admitted call appends to a promise chain with no queue limit. A caller can submit 40 calls every
   10 s while one action takes up to 600 s, so retained requests and memory grow without bound. A
   disconnect cancels the current action but not queued ones. Confirmed: a probe admitted 120 calls across
   three rate windows while one had started; all ran later. Reject excess pending work, bound the queue,
   cancel the specific queued request on disconnect.
2. **Should-fix, `tools/agent/resident-talk.ts:184`: the hourly model budget is checked after spending,
   with no reservations.** A call starts whenever usage is under the cap, whatever it will cost, and
   outstanding calls count toward neither budget. Confirmed: with budgets of one call and one token, three
   concurrent calls went out and recorded 1,296 tokens. Reserve a call and a token allowance synchronously
   before the fetch, then reconcile.
3. **Should-fix, `apps/server/src/agents/mcpHttp.ts:94`: concurrent legacy joins orphan seats.** Two
   requests can both see an empty session, join, and overwrite `legacy.seat`; DELETE closes only the last.
   Confirmed over HTTP with a deferred join: two seats before DELETE, one after. Serialise joins per
   session; after the await, close the result if the session was deleted meanwhile.
4. **Should-fix, `apps/server/src/agents/mcpHttp.ts:132`: legacy MCP cancellation is acknowledged but
   ignored.** Every notification answers 202 without handling `notifications/cancelled`, so a legacy
   client's cancel leaves its character fighting or walking for minutes. Track requests by session and
   request id and cancel the matching operation.
5. **Should-fix, `tools/agent/residents.ts:265`, `:340`: the people budget is checked only after residents
   join.** Start-up joins and runs the cast before it has a human count, and a failed count keeps that
   permission for good. With `maxHumans` set, get a valid count before joining and stay parked while it is
   unknown; add start-up-over-budget and count-failure tests.

## Checked and sound

Seat handles are 192-bit random and stored hashed; token lookup isolates seats (handles are transferable
bearer credentials, not bound to an address). Restricted joins stop caller-chosen hosts, identities and
admin roles. The production guest and origin-secret path passes its integration test. Speech uses
server-validated authored lines and DOM text insertion, so a model answer cannot introduce free text or
actions. Observations are bounded; both MCP protocol eras work on the happy path. Tests run one at a
time: gateway 7 passed, brain 6 passed, resident integration 4 passed.

## Not checked

Production proxy behaviour, sustained memory or CPU and slow clients, real Claude or Codex interop, the
browser presentation, the videos.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | `Session.call` is a bounded FIFO (8 locally, `GATEWAY_RULES.queuePerSeat` = 4 per seat, running call included); past it `queue full`, HTTP 429 with `Retry-After` (API and loopback bridge). Each call carries its caller's AbortSignal: a waiting call that hangs up leaves the queue unrun, a running one is stopped, and a queued caller's hang-up no longer stops another call. Stdio MCP and the bridge share the queue code and both pass the signal. | `55fdfb03`, `ba9488a5` |
| 2 | The brain reserves a call and a token allowance (prompt at 3 chars/token + `max_tokens`) synchronously before the fetch and reconciles to reported usage after; three concurrent calls on a one-call budget now make one request, on a one-token budget none. | `a3c939bd` |
| 3 | Legacy joins are serialised per session (a second join waits, then gets `already playing`); a join that finishes after DELETE (or the sweep) closes its seat. Also: a join whose HTTP caller hung up (API, modern MCP) drops the seat at once. | `ba9488a5` |
| 4 | `notifications/cancelled` (2025-11-25 cancellation: stop, free, no response; unknown ids ignored) aborts the named request in the same session over HTTP, and on stdio, where the cancelled reply is dropped. Over HTTP the POST still gets the cancelled result, which the spec has the client ignore. | `55fdfb03`, `ba9488a5` |
| 5 | With `maxHumans` residents start parked, take a valid count before any join, stay parked while the count is unknown (a later failure takes them out), retry every 5 s while unknown; the check fails closed and a non-numeric `--max-humans` is refused (it used to compare false and never apply). | `2a37fea0` |

Same class, fixed alongside: the residents' shared `Floor` and each resident's `greeted` map grew with every person met (`9fe74bda`).

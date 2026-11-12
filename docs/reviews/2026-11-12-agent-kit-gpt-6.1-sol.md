# Agent play: the kit, the agent flag and residents (lane/agents) — review round 1 (Codex gpt-6.1-sol)

Scope: `oasis/integration...d897848d`. Static review, reasoning effort high, Standard tier; no tests run.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | blocker | `apps/server/src/world/agents.ts:107`; `apps/server/src/app.ts:230` | Agent claims are keyed by user id alone. With both caps at 1: A reserves a seat, then sends another agent request with `sandbox: true`; it overwrites A's claim, fails authorisation and deletes it. B can then reserve the same room, and both seats stay usable because `seatRefusal()` doesn't re-check agent caps. The per-IP and per-room caps are bypassed without any race; other failed-request paths share the ownership problem. |
| 2 | should-fix | `packages/agent-kit/src/agent.ts:325` | `attach()` caches `me`, then awaits private state. A `close()` (or a disconnect) during that wait lets the continuation set `playing` and restart the movement and ping timers against the departed room. |
| 3 | should-fix | `packages/agent-kit/src/agent.ts:1278` | `pvp: false` only refuses a player chosen as the target. Attacking an NPC still sends melee and fire freely: the server's melee arc includes humans (`combat.ts:691`) and a projectile can hit a human in the way, so default residents can hurt people. |
| 4 | should-fix | `tools/agent/examples/hunter.ts:199`; `packages/agent-kit/src/agent.ts:1542` | The example hunter neither skips `claimedBy` creatures nor passes `yieldTo`; the defend-trial helper attacks without yielding (resident chasers use it). |
| 5 | should-fix | `apps/server/src/db/sessions.ts:132`; `apps/server/src/db/agentAccounts.ts:22` | Past sessions are classed by `agent_account` membership only: a saved account playing an agent session counts as human play, and linking an agent guest into an account reclassifies its history. |
| 6 | should-fix | `packages/agent-kit/src/auth.ts:66` | `writeFileSync(…, { mode: 0o600 })` only restricts a new file: an existing session file keeps its permissions when the cookie is written into it. |
| 7 | should-fix | `tools/agent/mcp.ts:82` | A JSON `null` message passes `JSON.parse`, then `msg.method` throws outside the request error handler: one malformed message ends the MCP process and drops its character. |
| 8 | nit | `apps/server/test/agent-accounts.test.ts:84` | The leave wait ends with `|| true`: it never checks the body left before reconnecting. |

Verdict: request changes (the claim bug is a blocker). Decisions and fixes are recorded below this line as they land.

## Fixes (lane/agents, 2026-11-12, Claude Fable 5.2)

All eight findings were accepted and fixed, one commit each, on top of the merge of `oasis/integration` (`fcbcc9ed`).

| # | Fix | Commit | Test |
|---|---|---|---|
| 1 | Every `/api/play` request of an agent holds its own claim (`Identity.agentClaim`); a failed request releases that claim only; every outstanding seat counts towards both caps until it is used or expires; `BodyRoom`'s seat check uses the claim up and re-checks the switch and both caps in the step that puts the body in (`useAgentSeat`). D-agents-15. | `ea54ee53` | `apps/server/test/agents.test.ts`: "each request has a claim of its own…" (the review's sequence with both caps at 1, then a travel-redirect failure, a second address, and the first seat used) and "a seat is admitted again when it is used…" |
| 2 | `attach()` carries its join generation and checks generation, room identity and closed status after every await and in the step that installs the timers; a stale attach lets go of its room and throws; a room that closes while being attached fails the attach instead of starting a second reconnect. | `1f492207` | `packages/agent-kit/src/attach.test.ts`: close during the wait, disconnect during the wait, a newer join superseding an older attach |
| 3 | `pvp: false` holds every weapon attack while a player is in the melee arc, on the projectile's path or in the splash/chain/thrown radius (`collateral.ts`); the agent steps round the target and gives up with `player in the way` after 5 s. D-agents-16. | `6ff0f20a` | `packages/agent-kit/src/collateral.test.ts` (arc, path, splash, spread, chain); `apps/server/test/agents.test.ts`: "with pvp off it doesn't swing through a person at its creature…" (live server: no swing, the person's HP untouched, the fight goes ahead once they leave) |
| 4 | The example hunter picks targets with `pickTarget()` (never a person's creature, nor one it yielded in the last 40 s) and attacks with `yieldTo: "people"`; the defend-trial helper's `threatNear()` skips a person's creature and its attack yields; both then pick another creature or wait. D-agents-17. | `8f42147c` | `tools/agent/tools.test.ts`: "the example hunter leaves a person's fight alone"; `packages/agent-kit/src/attach.test.ts`: "holding a place: a person's creature is left alone" |
| 5 | `session_log.agent` (migration 10) is written when a session starts; session totals, D1/D7 return and the agents line on /stats read the row. Older rows are classed once by `agent_account`. D-agents-18. | `75db48b2` | `apps/server/test/agent-accounts.test.ts`: "a session is an agent's or a person's by its own row…" (a saved account's agent session, an agent guest linked into an account, the backfill) |
| 6 | The session file is written to a new file opened exclusively with `0600` enforced by `fchmod`, synced and renamed into place; a symlink or non-regular file is refused for writing and reading; a file readable by others is tightened on read. D-agents-19. | `b67f772f` | `packages/agent-kit/src/auth.test.ts` (new file, existing `0644` file, symlink and dangling symlink, a folder in its place) |
| 7 | `parseRpc()` answers a line that is JSON but not an object (`null`, a number, a string, an array) with JSON-RPC `-32600`; the process goes on. | `42aca4b9` | `tools/agent/tools.test.ts`: "MCP: a line that is JSON but not a request" |
| 8 | The leave wait asks the server's rooms whether the agent's body (live or lingering) is still in the world, and asserts it was there before the close. | `7cc6b888` | `apps/server/test/agent-accounts.test.ts`: the first test (the wait itself) |

Not covered by a test: the defend-trial helper's yield is tested at its target choice (`threatNear`), not through a whole live defend trial with a person joining in.

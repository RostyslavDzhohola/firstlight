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

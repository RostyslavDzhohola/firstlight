# Balance model, tuning and starter stats (lane/balance) — review round 1 (Codex gpt-6.1-sol)

Scope: `1811d86c..lane/balance` at `b979f821`. Static review, reasoning effort high, Standard tier;
`pnpm balance` passed 485/485; no test suites run. No blockers.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | should-fix | `tools/balance/model.ts:86` | Cadence omits the server's 0.85 rate allowance (`combat.ts:293`): an L1 axe chop plus a light kills an 88-HP Hinoko after 0.68 s while the model says 0.8 s and passes the 0.75 s floor. |
| 2 | should-fix | `tools/balance/model.ts:80` | After an Ember Seal the model schedules a dart at once; the server's `castSpecial()` calls `markAttack()`, so the next dart waits at least 0.38 × 0.85 s. Hinoko's opener is overstated (D-balance-3's rationale). |
| 3 | should-fix | `tools/balance/model.ts:65` | The model delays melee damage by `def.windup`; the server's `melee()` applies it at once. Duel and PvE timings penalise melee with a delay the game doesn't have. |
| 4 | should-fix | `tools/balance/bands.ts:76` | TTK checks gate body-hit `ttk` and `openerTtk` but ignore `bestTtk`: an L1 Scatterpipe headshot volley deals 63, a two-shot kill in 0.9 s, under §2.5's 1.4 s burst floor, and every check passes. |
| 5 | should-fix | `packages/shared/src/content/weapons.ts:86`; `apps/client/src/game/CombatClient.ts:407–418` | The axe chop's new 6 s cooldown isn't mirrored on the client: it still sends and animates every charged release, the server refuses it as "not charged", and the client resets `lastFire`, delaying valid light attacks. |

Verdict: request changes. Decisions and fixes are recorded below this line as they land.

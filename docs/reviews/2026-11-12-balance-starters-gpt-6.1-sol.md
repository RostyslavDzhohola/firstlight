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

## Fixes (lane/balance, Claude Opus 5.5)

| # | Decision | Commit | Test | Numbers changed |
|---|---|---|---|---|
| 1 | D-balance-6: the model runs the client's cadence and the server's accepted one (0.85 × rate, 0.9 × charge); §2.5's bands stay at the client's, the hard floor (two hits, ≥ 0.75 s, every starter body) holds at the server's. Holding §2.5's 1.4 s there would slow the honest game ~15% (Stillshot head + body: 1.19 s); closing that gap is a server follow-up | `dbd3653f` | `tools/balance/model.test.ts` "the server's accepted cadence"; `pnpm balance` | Bearded Axe rate 0.8 → 0.9 (all tiers): chop + light on Hinoko/Hexwick 0.68 → 0.77 s |
| 2 | D-balance-7: the dart after a seal waits the rate; the server also let the hold run while darts flew (seal free, Hinoko won 16/16 duels again), so a throw now breaks the hand seal (server `fire()` + client). D-balance-3's trim was larger than needed at T1/T2, needed at T3 | `124e5a4d` | `model.test.ts` "the Ember Seal"; `apps/server/test/ember-seal.test.ts` "a throw breaks the hand seal" (red without the server change) | Ember Seal direct 24/32/42 → 30/40/42 |
| 3 | D-balance-5: the model matches the server (melee damage on the press); `windup` is no delay in the game | `15f36a25` | `model.test.ts` "melee damage lands on the press" | none |
| 4 | D-balance-8: best play (headshots, heavies, specials) gated at §2.5's 1.4 s; the hard floor counts headshots; the seal fireball takes its own tier's headMult in the model | `eb823498` | `model.test.ts` "the headshot floor" (incl. the gate failing on the old ×1.5 pellets); `packages/shared/src/content/content.test.ts` | Scatterpipe headMult 1.5 → 1; Ember Seal headMult 1.5 → 1; Yew Longbow rate 1.35/1.25/1.15 → 1.4; Comet III rate/reload 1.6 → 1.65 |
| 5 | The client mirrors the server's one special cooldown (seal, chop, slam): no charge, send or animation for a heavy that isn't ready, `lastFire` untouched, "Chop/Slam recharging" on the press; a ready release inside the rate waits for the gate | `2c59f120` | `apps/client/src/game/specialCooldown.test.ts` | none |

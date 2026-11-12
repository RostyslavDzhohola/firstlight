# Security pass (STATUS M9) — Codex gpt-6.1-sol

Scope: `oasis/integration` at `2eaa5aba`: auth and sessions, room messages, HTTP routes, movement and
combat validation, the client bundle, denial of service. Source review, reasoning effort high, Standard
tier, read-only, no remote requests. Not checked: deployed env values, proxy behaviour, the production
bundle, dependency advisories, real exhaustion thresholds.

| # | Severity | Where | Weakness | Fix asked for |
|---|---|---|---|---|
| 1 | high | `world/matchmaking.ts:123,145`; `app.ts:156,205` | Load-test identities bypass every resource ceiling (population, copies, per-IP calls, unused seats): whoever holds the load-test credential can mint identities and create unbounded copies on the production process. | Separate finite budgets for bots (population, rooms, reservations, creation rate) and an explicit production enable switch. |
| 2 | medium | `auth/routes.ts:208`; `env.ts:24` | Guessing the load-test secret is unthrottled and any non-empty secret enables it; `/api/metrics` is a second oracle. | Require a high-entropy credential; rate-limit failed checks per IP and globally on both endpoints. |
| 3 | medium | `app.ts:125–160`; `social/refusal.ts:16` | `/api/play` throttles only after JWT verification; invalid tokens and bodies never spend a budget, and an invalid token can be verified twice. | An early IP/global budget before verification, cheap field validation first, reuse the verification result. |
| 4 | medium (deployment-dependent) | `auth/ip.ts:41–54`; `app.ts:156`; `auth/accounts.ts:298` | IP limits trust proxy headers whose provenance isn't checked (`X-Real-IP`, first forwarded address); loopback bypasses play limits in production. | One documented trusted-proxy chain, validated addresses, IPv6 limits per /64, no loopback exemption in production. |
| 5 | medium | `auth/accounts.ts:219–257`; `auth/routes.ts:108`; `world/BodyRoom.ts:594` | Play JWTs aren't bound to their issuing session: a copied token works for account HTTP actions for up to 15 min after its session signs out, and can take a seat if any other session exists. | Put the issuing session (or a revocation version) in the JWT and check it. |
| 6 | medium | `auth/routes.ts:108–122` | Name changes have no rate limit or cooldown (each writes game.db and the auth user). | Per-account and per-IP limits, a cooldown, a no-op for an unchanged name. |
| 7 | low | `world/BodyRoom.ts:91,790–792`; `world/combat.ts:723–726` | Blocking assumes a unit facing vector but input only bounds components: `(1,1,1)` widens the block half-angle from 60° to ~73°. | Normalise and validate facing on input and in the block maths; reject zero length. |
| 8 | low | `auth/routes.ts:241–251` | The admin-claim limiter inserts a key for every rejected request once the global budget is spent; its 10,000-key cleanup is unreachable there. | Reject before inserting; hard cap; expire idle entries on every path. |

Found sound: production refuses `ALLOW_DEV_GUESTS`; admin-claim comparison is hashed and constant-time
with attempt limits and one-time use; no client-controlled grant of XP, coins, items, kills, mission
progress or medals in the handlers read; no player-string DOM XSS, input-built SQL, open redirect or
bundled server secret found.

Decisions and fixes are recorded below this line as they land.

## Fixes (lane/security, 2026-11-12, Claude Opus 5.5)

All tests are in `apps/server/test/security.test.ts` (in-process server) unless noted; each fails on the
code before its commit.

| # | Finding | Commit | Decision | Test (`describe` → cases) |
|---|---|---|---|---|
| 1 | Load-test identities bypass every ceiling | `cd5fcac7` | D-security-1 | "finding 1": bot population, copies per body and creation rate, unused bot seats and play calls, token minting rate, production needs `LOADTEST_ENABLED=1` (test guests still flagged; `/api/metrics` off) |
| 2 | Load-test secret guessable, any value enables it | `3476948a` | D-security-2 | "finding 2": a short secret switches bot tokens off (flagging still works), wrong guesses limited per address before comparing on bot tokens and metrics, and overall |
| 3 | `/api/play` throttles only after verification | `80b926b0` | D-security-3 | "finding 3": body/version before the token, per-address (IPv6 /64) and global budget with invalid tokens, one `verifyJWT` per refused request with the ban explainer |
| 4 | Proxy headers of unchecked provenance; loopback exempt in production | `43629f90` | D-security-4 | "finding 4": `X-Forwarded-For` and invalid `X-Real-IP` ignored on direct routes, loopback limited in production (not in development), IPv6 per /64 after verification |
| 5 | Play JWTs not bound to their session | `a3aa26f1` | D-security-5 | "finding 5": signing out one session kills its tokens and a seat it reserved while the other session works (saved account); a guest's token dies with its session. `auth.test.ts` payload test now lists `sid` |
| 6 | Name changes unlimited | `d9edc35d` | D-security-6 | "finding 6": unchanged name answers without a write and the next change waits; attempts per account and per address |
| 7 | Facing not normalised for blocking | `74ae654e` | D-security-7 | "finding 7": input facing normalised and zero length refused; a blow 70° off an over-long facing isn't blocked (checked to fail with the old block maths) |
| 8 | Admin-claim limiter grows after the global budget | `c9dec9e9` | D-security-8 | "finding 8": refused attempts record nothing, idle addresses expire on any call, the shared limiter caps its keys |

New production env: `LOADTEST_ENABLED=1` only for the duration of a load test (with a strong `LOADTEST_SECRET`).
Still to verify on the deployment (D-security-4): that Railway's edge overwrites a client-supplied
`X-Real-IP`, and that the first `X-Forwarded-For` entry behind the Vercel rewrite is the browser's.

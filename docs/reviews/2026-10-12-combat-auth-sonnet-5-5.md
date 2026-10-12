# Combat + auth review (Claude sonnet-5-5, 2026-10-12)

Read-only review of the first combat/auth/persistence slice. Fixes applied in the hardening pass (see DECISIONS D26).

# Review of `9853521..HEAD` (server, client net/game, shared): FIRSTLIGHT combat core, rooms, matchmaking, accounts, persistence

I ran `vitest run` in `apps/server` (107 pass), `tsc` on server and client (clean) and the shared tests (16 pass). None of the existing tests cover the bugs below.

I reproduced most Blocker and several Should-fix items with throwaway scripts against committed code. The scripts were in `/tmp/fl-probe`, which another process has since overwritten, so I give repro steps instead. I changed no repo files.

Line numbers refer to committed HEAD (`BodyRoom.ts` and `combat.ts` are identical to 9c2959e). The working tree now has uncommitted edits by someone else, plus an untracked `docs/reviews/2026-10-12-combat-auth-codex-sol.md`. I did not read the review file, so re-check each item against those edits.

## Blocker

**B1. Duplicate or ghost bodies cause item duplication and stale overwrites** (`BodyRoom.ts:203-215, 281-314, 128-141, 483-495`)
- Reproduced three ways:
  1. A second login with the same account leaves the old body in `room.actors`. Killing it drops a pile of `[carbine, axe]` while the new session keeps both.
  2. Drop an item, then log in again at once. The item is in the pile and in the new session's hotbar, because `drop()` never saves the character.
  3. Quit outside a safe zone so the body lingers, join Portus, then kill the lingering body. The pile holds carbine, axe and 500 coins, and the Portus session still has all of them.
- Causes:
  - `client.leave(4001/4002)` is not `CONSENTED`, so Colyseus routes it to `onDrop` (`Room.mjs` `_onLeave`). That calls `allowReconnection(30)` and the body stays for 30 s.
  - The client is removed from `clients` when it drops, so `clients.getById(...)` (:206, :140) cannot find sessions in their reconnect window.
  - `onLeave` unregisters the session (:301) before lingering, and `onJoin` reclaims lingering only in the same room (:209).
  - `onJoin` loads the DB row (:215) before the old session's final save. That row can be 30 s old and misses the linger-start state.
  - `saveActor` (:780) never checks that the actor is still the live session. Linger expiry, `onLeave` and kill-credit saves clobber the new session.
- Honest players hit this too, whenever the SDK fails to reconnect and the client rejoins.
- Fix:
  - Add a process-wide registry `userId -> {roomId, sessionId, state: live|dropped|lingering}`. At the top of `onJoin`, before `load`, call `evict(userId)` on the owning room.
  - `evict` saves the old actor synchronously, deletes it from `actors`/`lingering`/`state.players`, sets `actor.superseded = true` (so it never saves again), then calls `leave(KICK_CODE)`.
  - `onDrop(client, code)` must skip `allowReconnection` for kick codes and during shutdown. `onReconnect` must reject superseded actors.
  - Prefer reclaiming the live actor (its position, hp and `char`) over loading from the DB.
  - Persist `drop()` and `use()`, and write the pile and the character in one transaction.

**B2. The client rejoins on every close code except 1000 and 4000** (`apps/client/src/game/Game.ts:148-151`)
- Colyseus' `SERVER_SHUTDOWN` is 4001, the same code the server uses for "signed in elsewhere". Two tabs on one account will kick each other every 1.5 s, and each cycle leaves a 30 s ghost body (see B1).
- 4002 is `WITH_ERROR`, so it also covers zod rejections and the message rate limit.
- Fix: use custom codes of 4100 and above for "signed in elsewhere" and "account merged". On "signed in elsewhere", show a screen and do not rejoin. Add backoff and a retry cap for the other codes.

**B3. Movement budget allows roughly 40x speed, and flying** (`BodyRoom.ts:334-342`, `MOVE` at :44-50)
- Each message is allowed `9*max(0.05,dt)*1.25 + 4.5 (dodge) + 1.0`, about 6 m, with no cap on accumulation. With 60 messages/s that is about 360 m/s.
- Reproduced: 40 inputs of 5 m at 20 ms spacing moved the player 199.6 m in under a second with 0 violations.
- `maxAboveGround: 40` lets a client hover 40 m up. `fallDamageFraction` is never used, and `violations` (:344) is never read.
- Fix:
  - Use a token bucket (`budget += speed*realDt`, capped at about 1 s of travel), with no minimum-dt clamp.
  - Allow the dodge burst only on a server cooldown of 1.2 s.
  - Limit upward velocity to jump height plus slope.
  - Disconnect on sustained violations.

**B4. Production configuration fails open** (`main.ts:12-15`, `env.ts:15,19,26`, `accounts.ts:192-200`)
- `ALLOW_DEV_GUESTS=1` accepts `dev:<anyUserId>:<name>:admin`. That gives in-room admin commands (kill anyone, give items) and impersonation of any account whose id is visible, since `PlayerState.userId` is synced to everyone (`schema.ts:69`). STATUS.md says live Railway still sets this flag.
- `if (cfg.originSecret)` skips the gate when `ORIGIN_SECRET` is empty. Then `x-firstlight-client-ip` comes from the attacker-controlled first `X-Forwarded-For` entry, which defeats rate limits and IP bans.
- `BETTER_AUTH_URL` defaults to localhost, which gives wrong JWT `iss`/`aud`.
- Fix: in `main.ts`, throw when `env.production` and any of these hold: `allowDevGuests` is set, `originSecret` is empty, `authUrl` is not https, or the admin claim token is shorter than 32 characters. Remove the Railway variable now.

**B5. `/api/play` has no throttle, so one guest can lock out the server** (`app.ts:81-112`, `matchmaking.ts:98`)
- Reproduced: one account made 72 never-consumed seat reservations, which filled both Arcadia copies. A second player was queued. Each reservation lasts 15 s, and guests cost nothing (20 per minute per IP).
- Fix: add a per-user and per-IP token bucket. Allow one outstanding reservation per `userId` (reuse or reject a second request).

## Should fix

6. **Combat logging via a sticky flag** (`BodyRoom.ts:304, 615, 710`).
   - `loggedOut` is set and never cleared. Reproduced: log out on the pad ring, walk 60 m out, `leave()`. No linger body appears, unlike the control without the flag.
   - The countdown only cancels when a single message moves more than 0.4 m (`:349`), and attacking does not cancel it.
   - Fix: the server should call `client.leave()` itself at completion, clear the flag on movement, attack or damage, and cancel when the player is more than 0.5 m from a stored start position.

7. **Bow draw and heavy melee are unvalidated** (`combat.ts:163-164, 329`; `weapons.ts:83, 113`).
   - The bow's `charge` comes from the client and defaults to 1, with `rateScale` 0.5. Reproduced: 8 full-damage arrows in 2 s, against a design of about 1 per 1.5 s (draw 1.0 + rate 0.5).
   - `heavy` is a client claim, and the hammer's `cooldown: 6` is never read.
   - Fix: track draw and charge start on the server and enforce the cooldown.

8. **Safe-zone immunity while combat-tagged** (`combat.ts:57-69`, `BodyRoom.ts:703`; SPEC §5.3). A player can shoot, step into a 12 m pad ring and take no damage. Make `PF.SAFE` effective only when `now >= combatUntil`.

9. **Invulnerable and dead bodies absorb hits** (`combat.ts:98, 336-342, 428`; `BodyRoom.ts:554`).
   - `raycastActors` ignores `canHurt`, and melee takes `slice(0, maxTargets)` before filtering.
   - Corpses stay in `actors` until the owner's client leaves. Protected and safe players also block.
   - Fix: filter with `canHurt` before choosing the nearest or first N targets.

10. **Display-name rules are bypassable** (`accounts.ts:167`, `routes.ts:36`, `better-auth.ts:68-93`).
    - Reproduced: `POST /api/auth/update-user {name: "<b>ADMIN</b>" + 100 x's}` returns 200 and the name is shown to all players. The 3-16 length, filter and uniqueness checks are skipped.
    - The HUD uses `textContent` today, so there is no XSS yet.
    - Fix: derive the identity name only from `account.displayName`, falling back to `Wanderer-<hash(sub)>`. Deny `/update-user` in the `before` hook and cap the length.

11. **Admin claim** (`routes.ts:105-132`).
    - The session cookie is host-only on `firstlight.one4all.dev`, but the route is on the API host, so a browser GET never carries the cookie. The claim will always return 401.
    - It also accepts guest accounts, which are lost when cookies clear and the token is burnt. It is a state-changing GET with the token in the URL and logs.
    - Fix: have a client page POST `{token}` with the Bearer JWT, require `!guest`, and rate limit it.

12. **Account link races** (`accounts.ts:121-127`, `link.ts:62`, `BodyRoom.ts:128-141`, `sqliteStores.ts:53`).
    - The merge compares DB rows that can be up to 30 s stale. The losing character is deleted silently.
    - The displaced session's final save overwrites the merged row.
    - `ensureAccount` inside `save()` defeats the `WHERE EXISTS` guard at `characters.ts:83-94`, so a late save recreates the merged guest's rows.
    - Fix: flush live actors of both ids before `linkAccounts`, evict the displaced actor, and remove `ensureAccount` from `save`.

13. **Reconnect bugs** (`BodyRoom.ts:287-294`).
    - A player killed during the drop window never gets the `death` message, because the broadcast skips dropped clients. The client is left frozen with no death screen.
    - There is no ban re-check, which SPEC §5.2 requires.

14. **No per-message-type limits** (`BodyRoom.ts:143-184`).
    - Only `maxMessagesPerSecond = 60` applies. Drop and pickup loops do synchronous SQLite writes on the tick thread. By my bench estimate (0.12 ms per pile insert, 0.05 ms per save), 40 abusive clients take about 30% of a core.
    - `phrase` rebroadcasts to everyone with no cooldown.
    - Fix: cap inventory operations at about 5/s and phrase at one per 1.5 s.

15. **Information exposure** (`schema.ts:113`, `BodyRoom.ts:740`, `combat.ts:173, 382`).
    - Every player position syncs to every client, contrary to SPEC §5.2's 160 m views.
    - `hit`, `shot` and `death` are broadcast room-wide with coordinates.
    - `userId` and the ADMIN flag are exposed.
    - Fix: per-client views for players, route combat events to nearby viewers, and drop `userId` from the schema.

16. **OTP abuse** (`better-auth.ts:73-82`).
    - The send endpoint needs no session, and the per-email key is not normalised, so `+tag` aliases bypass the 3-per-hour cap.
    - Anyone with a few IPs can drain the 1000-per-day budget or mail-bomb third parties from the login domain.
    - Fix: require the guest session cookie, add per-IP and per-session caps, and normalise emails.

17. **Matchmaking trusts client claims** (`app.ts:99-100`, `matchmaking.ts:81-89`). `partyLeaderRoomId` and `partySize` are client-supplied. Any user can bypass the 36-seat solo limit. Ignore them until a server-side party exists.

18. **`fire` handler ordering and spread RNG** (`BodyRoom.ts:148`, `combat.ts:171, 177, 15, 159`).
    - `equip` runs before validation.
    - Spread RNG is seeded from `now ^ client seq`, so a cheater can bias it. Use `Math.random()`.
    - `ORIGIN_SLACK = 7` with no line-of-sight check lets shots start 7 m away, past ridges.

## Nice to have

- `Net.attach` leaks one `setInterval` per join (`Net.ts:100`).
- `onDrop` during shutdown rejects "disposing" unhandled for every client (`BodyRoom.ts:284`). It is noisy, not a crash. Guard on `shuttingDown`.
- The autosave loop (`:734`) is unbatched, and one throw skips the rest. Use `saveCharacters` in a transaction with a per-actor try/catch.
- The patchkit heals 1.5x its stat (`BodyRoom.ts:410`). The hammer slam hits arc targets twice (`combat.ts:342-349`). Melee level-gate denials are silent.
- `NET.REWIND_MS` is 200 but `combat.ts` uses 150. `FireMsg.t` is ignored, although SPEC §5.3 says to rewind by client time.
- Swim-no-attack and fall damage are not enforced server-side (SPEC §4.3).
- `autoDispose` removes a room that holds only lingering bodies (empty `clients`), so the 30 s linger rule fails in empty rooms.
- PvP XP has no repeat-victim decay, so alts can farm it (`progression.ts:55`). Load-test bots persist characters and piles, evict real piles, and get uncapped copies (`matchmaking.ts:91`).
- `x-real-ip` is trusted first (`ip.ts:33`). Verify Railway overwrites it. IPv6 ban hashes should use a /64 prefix. `/api/metrics` compares the secret with `!==` (`app.ts:117`).
- Name changes have no cooldown. Anonymous users and `account` rows are never pruned.
- `kill()` writes the pile and the character in separate statements (`:562-572`).
- `sendYou` is sent on every shot because `consumeAttack` sets `youDirty` (`combat.ts:129`). Send the mag delta instead.
- The kicked-session `kicked` message type exists but is never sent.

## Tick performance (measured, not estimated)

Nothing measured threatens the 50 ms budget:

| Operation | Cost |
|---|---|
| AOI pass (40 clients x 1000 piles x 300 NPCs) | 1.7 ms per 200 ms |
| 150 m `rayTerrain`, worst case | 18 µs |
| `rayCapsule` | 0.25 µs |
| Autosave of 40 characters | 2 ms |
| Pile insert at the cap | 0.12 ms |

The real risks are the unthrottled per-message SQLite writes (item 14) and the room-wide event fan-out (item 15). I did not measure WAL checkpoint cost on the Railway volume, and `tickTimes` (`:689`) excludes patch encoding. I also did not test real Vercel or Railway header behaviour, or the live client.

## Against the uncommitted tree

I only skimmed the working-tree diff. It appears to address B1, B3, items 6-8 and 12-13, and parts of 14 and the fall/swim items, through a superseded-actor registry, a move budget, a logout start position, charge timers and a before-link flush.

These files are untouched, so the items in them are still open:
- `main.ts` and `env.ts` (B4)
- `app.ts` and `matchmaking.ts` (B5, item 17)
- `better-auth.ts` and `routes.ts` (items 10, 11, 16)
- `Game.ts` (B2)
- `schema.ts` (item 15)

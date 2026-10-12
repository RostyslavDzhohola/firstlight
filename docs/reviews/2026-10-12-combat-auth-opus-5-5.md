# Combat + auth review (Claude opus-5-5, 2026-10-12)

Read-only review of the first combat/auth/persistence slice. Fixes applied in the hardening pass (see DECISIONS D26).

I found 5 blockers, 14 should-fix items and 12 nice-to-haves. Server tests pass (6 files, 63 tests) and `tsc -p tsconfig.json` is clean, but none of the tests cover the blocker paths.

I confirmed blockers 1, 2, 3 and 4 and should-fix 1 by running the real server in-process with small probe scripts in `/tmp/fl-probe/`, outside the repo. No repo files were modified.

## Blocker

**1. Any player can shut down the whole server** — `apps/server/src/world/BodyRoom.ts:284`
- `onDrop` throws away the promise from `allowReconnection`. If a socket closes after the server sends JOIN_ROOM but before the client acks it, Colyseus rejects that promise with `"not joined"`. Nothing catches it.
- In production (`gracefulShutdown: true`) Colyseus treats any uncaught error as fatal: it shuts down and calls `process.exit(1)`. Everyone is disconnected.
- Confirmed: open the WebSocket with a seat reservation and close it on the first frame. The same rejection (`"disposing"`) also fires on every graceful shutdown.
- Any exception thrown in onJoin (for example a SQLite error) takes the same path. BodyRoom has no `onUncaughtException`, so errors thrown in the tick or in message handlers also end the process.
- **Fix:** `this.allowReconnection(client, NET.RECONNECT_WINDOW_S).catch(() => {})`, and skip it when shutting down. Add an `onUncaughtException(err, method)` on BodyRoom that logs instead of exiting.

**2. Items can be duplicated, and one character can have several bodies** — `BodyRoom.ts:203-215`, `:296-314`, `:483-495`
- onJoin always loads the character from the database. It ignores any live, dropped or lingering actor for the same user that still holds newer state in memory.
- Kicked or dropped sessions stay in `actors` for the 30 s reconnection window. They keep autosaving and do a final save when they leave.
- `drop` does not save. The linger path in onLeave does not save. Reclaiming a lingering body (`:209-213`) throws it away without saving.
- Confirmed: drop the starter weapon, then join again from a second tab. The new session has the weapon, the pile still has it, and the room holds two actors for that user.
- Other routes to the same outcome:
  - Refresh the page (no kick at all, because the dropped client is no longer in `clients`).
  - Leave on purpose outside a safe zone and rejoin.
  - Call `/api/play` again to "travel".
  - Kill your own old body with an alt while the new session keeps the items.
  - A kicked tab can also manually reconnect with its token: `onReconnect` (`:287`) checks nothing.
- **Fix:** keep one authoritative in-memory character per user for the whole process (extend `SessionRegistry`).
  - On join, take over the existing actor's `char` object (connected, dropped or lingering, any room). Remove that actor synchronously and stop it from reconnecting.
  - If the old body is lingering outside a safe zone or in combat, refuse `/api/play` with a retry-after until the linger ends.
  - Save on every inventory change (drop, move, use, thrown, respawn) and in the linger path.

**3. Two tabs or browsers kick each other forever** — `BodyRoom.ts:137,140,206`; `apps/client/src/game/Game.ts:151`
- The server kicks with code 4001 ("signed in elsewhere") and 4002 ("account merged"). Those codes are Colyseus's `SERVER_SHUTDOWN` and `WITH_ERROR`; `docs/tech-facts.md` §4 says 4000–4010 are reserved.
- The client rejoins on anything except 1000 and 4000. So each kicked tab rejoins after 1.5 s and kicks the other one.
- Because 4001 is not a consented close, every kick also holds a reconnection seat for 30 s. The ping-pong fills the room.
- This happens in the second-browser test flow (T5) whenever the first browser stays open.
- **Fix:**
  - Use app codes of 4100 and up.
  - Before kicking, mark the actor as superseded so `onDrop` goes straight to `onLeave`.
  - On the client, show "Playing in another window — Play here" for that code and don't rejoin automatically.

**4. Speed hack up to ~200 m/s** — `BodyRoom.ts:334-342`, `:44-50`
- Every input message gets the full dodge burst plus slack (5.5 m), and `dt` is floored at 0.05 s.
- Confirmed: 5 m steps every 20 ms were all accepted (206 m/s, 0 corrections). With 60 messages/s allowed, the theoretical ceiling is about 360 m/s.
- Because `lastMoveAt` only updates on accepted moves, time spent idle also banks distance for one big jump.
- Players can also hover up to 40 m above ground, while D3 says ground height ±0.3 m.
- **Fix:**
  - Use a per-actor distance budget: refill at `maxSpeed × 1.15 × min(elapsed, 0.25 s)`, capped.
  - Grant the dodge allowance at most once per 1.2 s (the client's cooldown).
  - Validate airborne movement against jump speed and gravity instead of the 40 m ceiling.

**5. Re-keying characters when a guest saves loses or duplicates data** — `apps/server/src/auth/accounts.ts:121-127`; `apps/server/src/db/link.ts:28-29`; `BodyRoom.ts:128-141`; `apps/server/src/world/sqliteStores.ts:53`
- The merge compares database rows that can be up to 30 s stale. Live actors are not saved first.
- The displaced account session, and the guest kicked with 4002 (holding a reloaded copy), both stay in the room and keep saving under the same user id. Whichever leaves last decides the result, which can overwrite the character that won the merge.
- Lingering guest bodies are not re-keyed.
- `SqliteCharacterRepo.save` calls `ensureAccount`, which defeats `saveCharacter`'s "no account row" guard. Late saves under the guest id recreate orphan account and character rows.
- **Fix:**
  - Before calling `linkAccounts`, save every live actor of both ids.
  - Hand the winning in-memory character to the surviving actor and remove the other synchronously (as in blocker 2).
  - Re-key lingering bodies too.
  - Remove `ensureAccount` from `save`.

## Should fix

1. **One guest can lock everyone out** — `apps/server/src/world/matchmaking.ts:61-100`, `apps/server/src/app.ts:81`. There is no per-user reservation cap or rate limit on `/api/play`, and every call reserves a new seat for 15 s. Confirmed: 72 calls with one token filled both Arcadia copies and the next player was queued. Keep one outstanding reservation per user (return the existing one), rate-limit per user and IP, and shorten `seatReservationTimeout`.
2. **Bow charge and heavy melee trust the client** — `apps/server/src/world/combat.ts:163-164,194`, `:328-329`. The client-sent `charge: 1` is accepted with a 0.5× rate scale, so full-draw arrows fire about every 212 ms (about 4.7× intended). `heavy: true` is accepted with no charge time: the axe does 66 damage instead of 30 at the same rate. Track draw and charge start on the server (RMB-down message) and ignore `msg.charge`. Enforce the hammer's 6 s `cooldown`, and don't double-hit arc targets with the slam (`:344-349`).
3. **Logging out can be abused** — `BodyRoom.ts:304,615,710`. The `loggedOut` flag is never cleared. Log out once in a safe zone (instant), keep playing, and any later consented leave makes the body vanish instantly with no linger. Attacking doesn't cancel the countdown either. Disconnect the client when logout completes (or clear the flag on any move or attack), and cancel the countdown in `consumeAttack`.
4. **Movement rules from the spec are missing** — `BodyRoom.ts:329-366`. Players can run into a safe zone while combat-tagged and become immune (SPEC §5.3 says they can't). Fall damage is only computed on the client (`apps/client/src/game/PlayerController.ts:147`) and never applied by the server. Falls of more than 40 m off the 60–120 m peaks get snapped back. Apply fall damage on the server from the validated trajectory, and block safe-zone entry while `combatUntil > now`.
5. **Production config can disable security** — `apps/server/src/main.ts:14`, `accounts.ts:192`. `ALLOW_DEV_GUESTS=1` would let anyone mint `dev:<anyUserId>:x:admin` (impersonation plus admin). A missing `ORIGIN_SECRET` silently turns the proxy gate off, which makes the forwarded IP spoofable (bypassing rate limits and IP bans). Refuse to boot in production when dev guests are on, when the origin secret is empty, or when `BETTER_AUTH_URL` / `CLIENT_ORIGIN` are unset. Prefix dev user ids so they can't collide with real ones.
6. **Display names can bypass the filter** — `accounts.ts:167`, `apps/server/src/auth/better-auth.ts:49-129`. Better Auth's `/update-user` accepts any `name`, and so does `/sign-in/email-otp`. That name becomes the in-game name whenever `display_name` is null, and the link event's name. Add `disabledPaths: ["/update-user"]`, validate or drop `name` in the before-hook, and never show the raw Better Auth name (use the display name or a generated `Wanderer-NNNN`).
7. **Reconnects skip ban and live-session checks** — `BodyRoom.ts:287-294`. SPEC §5.2 requires the ban check on reconnect. Check `isBanned` and `liveSessions.isLive(userId, sessionId)` in `onReconnect`; if either fails, call `client.leave()`.
8. **Heals are inflated about 1.5×** — `combat.ts:494`. `Math.round(hp + add + 0.49)` per tick: a small tonic heals 60 instead of 40, a large one 160 instead of 120. Accumulate fractions the way burn does.
9. **Blocking while attacking** — `combat.ts:116-151`. Blocking (70–80% frontal reduction) stays on while attacking. Deny the attack or drop the block in `consumeAttack`.
10. **Shots can come from inside or over terrain** — `combat.ts:15,159`. The shot origin may be up to 7 m from the head with no line-of-sight check. Ray-march from head to origin against terrain, or cap it at the camera boom length.
11. **Load-test bots can join public rooms** — `matchmaking.ts:62-63`. The check only stops normal players entering bot rooms. Also refuse `identity.loadtest && !input.loadtest` (DECISIONS: no fake players, ever).
12. **Travel and rebirth location aren't checked** — `matchmaking.ts` / `BodyRoom.ts:575-584`. `/api/play` takes any body at any time (combat escape, and rebirth outside Portus). Issue travel tickets from portals and pads on the server, and force Portus after `respawn`.
13. **Client doesn't retry after a deploy** — `Game.ts:88-96,151`. If the first rejoin fails while the server is restarting, `travel()` rejects silently and the player is stuck; SPEC §5.1 requires auto-rejoin. Retry with backoff and show a status.
14. **Linger ends early in an empty room** — `BodyRoom.ts:77`. With `autoDispose`, a lingering body disappears about 1 s after the last client leaves. Keep the room alive while `lingering.size > 0`.

## Nice to have

- **Bandwidth and egress:** `shot`, `hit` (once per pellet), `projectile`, `swing` and `explode` go to all 40 clients (`combat.ts:173,382`). `sendYou` resends the whole inventory on every magazine shot. Filter events by distance and send magazine deltas.
- **AOI cost:** `updateViews` (`BodyRoom.ts:741-761`) does 40 clients × up to 1,000 piles × 5 Hz with array allocations. Use the chunk spatial hash from the spec.
- **Lag compensation:** fixed `REWIND_MS = 150` ignores `msg.t`. Compute the rewind from client time, clamped to 200 ms (SPEC §5.3).
- **Writes:** not batched — `saveCharacters` is unused, and every save also writes `ensureAccount`. Wrap pickup (`:469-480`) and kill (`:562-572`) in one transaction each.
- **Party headroom bypass:** `partySize` and `partyLeaderRoomId` are trusted (`matchmaking.ts:64,81-88`), so solo players can skip the 36-seat rule (D12).
- **Queue:** pruning uses first-seen time with a 10-minute cutoff, despite the "30 s" comment (`matchmaking.ts:108-110`). Long waits get reset to the back.
- **Pile cap griefing:** drops and free guest alts (starter weapons) can fill the 1,000-pile cap and evict real death piles. Rate-limit drops and mark starter weapons.
- **Merge rule:** it ignores `dead`, so a dead higher-level character beats a live one (`link.ts:62`).
- **Small abuse vectors:**
  - Phrases can be spammed up to 60/s (`:180`).
  - Clients can send server-only animations such as DEAD (`:363`).
  - `/api/metrics` compares its secret with `!==` (`app.ts:117`).
  - The admin claim works on a guest account, so a lost cookie means the admin is lost.
- **Cleanup:**
  - `Net.attach` adds a new ping `setInterval` on every join and never clears it (`apps/client/src/net/Net.ts:100`).
  - Nothing subscribes to the `announce` channel, so admin announcements don't reach other rooms.
  - Unsaved guest accounts are never pruned.
  - The global OTP budget can be drained by sending codes to random addresses (consider the optional captcha).
- **Verify in production:** whether Railway overwrites a client-supplied `X-Real-IP`. If it doesn't, IP bans on `/api/play` can be bypassed (`apps/server/src/auth/ip.ts:33`).

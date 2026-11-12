# Playwright journeys

The game played the way a new player plays it, headless and muted (D-e2e-1, HANDOFF item 6i). The
command lines, environment and projects are documented at the top of `playwright.config.ts`.

- `pnpm e2e`: every journey against a local stack (server and a production client build on their own
  ports, fresh databases).
- `pnpm e2e:prod`: the read-only `@smoke` subset against https://firstlight.one4all.dev.
- `pnpm e2e:gate`: only the journeys in `gates.json`; a failure blocks a deploy.
- Evidence runs that `pnpm e2e` skips: `bench-warmup.spec.ts` (`BENCH_MODE`) and `artpacks.spec.ts`
  (`ARTPACKS=shots|bench`: the HD art packs' same-frame screenshots and frame-time bench, #48).

## Test accounts on production (D-home-6)

The owner wants the leaderboard, "online now" and the stats to show only real people. Every guest a
journey creates sends our tools' header, `x-loadtest-secret`, with its requests to the game server
(`fixtures.ts` overrides `context`; `j6-save.spec.ts` marks its second browser), so the server flags
it as a test account and keeps it off every public surface.

- **Production test runs must use `pnpm e2e:prod`** (or send the header themselves, scoped to
  `https://api.firstlight.one4all.dev`, see `stack.ts` `markToolRequests`). Any other run creates
  guests the server counts as real players.
- `pnpm e2e:prod` reads `LOADTEST_SECRET` from the environment or `~/.config/firstlight/.env` and
  refuses to start without it. It never prints the value. The header goes only to the game server,
  never to the client origin or a third party.
- Local runs give the stack a throwaway secret (`LOCAL_TOOL_SECRET`) and send it too, so every local
  run also exercises the flag.
- The server flags only guests (never a saved account), only with the right secret; without
  `LOADTEST_SECRET` set on the server the header does nothing.

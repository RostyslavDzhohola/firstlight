# AGENTS.md

FIRSTLIGHT is a free, open-source multiplayer browser game: a persistent multi-planet open world.
Code is MIT (`LICENSE`), our own art CC BY 4.0 (`LICENSE-ART`).

## Read before you change things

- `docs/SPEC.md`: what to build, in what order, and how it is checked.
- `docs/DECISIONS.md`: owner decisions and run decisions (`D<n>`). Later entries override earlier
  ones; where a run decision and the SPEC disagree, the decision is the newer word (D23, D25).
  Record a new decision at the bottom of "Run decisions" as
  `- **D<n> (<time>):** <decision>. Why: <reason>.`
- `docs/STATUS.md`: live progress, lanes, open issues. The builder (lead agent) owns it.
- `docs/content.md`: every game number (weapons, enemies, bosses, XP, missions, eggs, medals).
- `docs/tech-facts.md`: verified library versions, APIs and service limits.
- `docs/ASSETS.md`: the third-party licence registry. Update it with any new asset or bundled library.
- `docs/tests/e2e-cards.md`: the browser E2E cards T1–T8.

## Layout

- `apps/client`: Vite + three r186 (`three/webgpu`, TSL node materials, WebGL2 fallback). The UI is
  plain DOM + CSS (D25). `src/render` renderer and quality tiers, `src/world` planet, props, NPC
  rendering, `src/game` loop, controller, combat/quest clients, photo mode, `src/net` Colyseus client
  and auth, `src/ui` HUD, panels and screens (`ui/README.md` is the HUD API), `src/social`,
  `src/voice`, `src/audio` (SFX: ElevenLabs samples from the asset Worker with ZzFX stand-ins; generated music).
- `apps/server`: Node 24, Express, Colyseus 0.18, Better Auth, SQLite (better-sqlite3). `src/world`
  holds `BodyRoom` (one room = one copy of one body) and the systems: `npc/`, `quests/`, `voice/`,
  destruction, sky. Also `src/auth`, `src/db` (game.db schema and migrations), `src/social`,
  `src/ops` (`/admin`, `/stats`). `app.ts` builds the server so tests can run it in-process.
- `packages/shared`: deterministic code both sides import: `planet/` (terrain height function, pads,
  portals), `content/` (catalogues), `net/` (protocol types, Colyseus schema, close codes). No DOM, no three.
- `apps/assets-worker`: Cloudflare Worker serving large assets under `/v/<buildId>/…`.
- `tools/bots` load-test bots; `tools/blender/characters` headless Blender build of the starter GLBs;
  `tools/sfx` ElevenLabs sound-effect generation and processing (writes to `/tmp`, never the repo).
- `tools/blender/chars3d` (characters) and `tools/blender/props3d` (weapons, held props): models
  sculpted in code. To make or change one, follow `.claude/skills/models-as-code/SKILL.md`.

## Commands

Scripts live in the `package.json` files. The ones you need:

- `pnpm dev`: server (`tsx watch`, :2567) and client (Vite, :5173) together.
- `pnpm typecheck`: TypeScript 7 (`tsc`) for shared, server and client. TS 7 only typechecks; it has no compiler API.
- `pnpm test`: every Vitest project. One file: `pnpm vitest run apps/server/test/combat.test.ts`;
  one project: `pnpm vitest run --project server` (`shared`, `server`, `client`).
- `pnpm --filter @firstlight/client build`: production client bundle (no source maps).
- `pnpm --filter @firstlight/server start`: runs `src/main.ts` directly, like production (`apps/server/Dockerfile`).

Several worktrees share one machine. Give your stack its own ports: `PORT`, `CLIENT_PORT`,
`API_PROXY_TARGET`, `VITE_API_URL`, `CLIENT_ORIGIN`, `BETTER_AUTH_URL` (example in
`docs/tests/e2e-cards.md`). The full suite is load-sensitive: when a test times out, rerun that
file alone before calling it a failure.

## Code rules

- **Erasable TypeScript** in `apps/server` and `packages/shared`: production runs the `.ts` sources
  with Node's type stripping, so use only syntax that strips away: no `enum`, `namespace`, parameter
  properties or decorators. Use `as const` objects, unions and explicit fields.
  `apps/server/test/strip-types.test.ts` enforces it. Relative imports end in `.ts`; type-only
  imports use `import type`.
- **Colyseus state** uses the `schema()` / `t.*` builders in `packages/shared/src/net/schema.ts`, never decorators.
- **Pins:** exact versions (SPEC §3), lockfile committed. The client SDK is `@colyseus/sdk`, never `colyseus.js`.
- **Server authority:** damage, loot, XP and all state changes happen on the server. The client
  predicts movement only; the server validates it (D3).
- **Content ids by index:** `NpcState.kind` indexes `NPC_DEFS` and `PlayerState.weapon` indexes the
  item defs. Append to these arrays; reordering or removing entries breaks live clients.

## Extension points

- **Room systems** (`apps/server/src/world/systems.ts`): implement `RoomSystem` (`tick`, optional
  join/leave hooks, `decorateYou`, `onAdmin`, `canReconnect`, `dispose`) and
  `SYSTEM_FACTORIES.push(createX)`. Register messages inside the system with
  `room.onMessage(type, zodSchema, handler)`.
- **Game event bus** (`apps/server/src/world/events.ts`): `emitGameEvent(room, e)` /
  `onGameEvent(room, h)`, one bus per room, throwing handlers are isolated. New event: add an
  interface and a member of the `GameEvent` union. Missions, medals and eggs listen in `quests/QuestSystem.ts`.
- **Admin commands:** built-ins are the switch in `BodyRoom` (teleport, give, level, coins, heal,
  unprotect, damage, announce); anything else reaches each system's `onAdmin`. The client console
  and its help line are in `apps/client/src/ui/panels.ts`.
- **Client systems** (`apps/client/src/game/systems.ts`): `CLIENT_SYSTEMS.push(factory)`; set
  `factory.offline = true` to also run without a server (`?offline`, `?bench`).
- **Net messages:** TypeScript shapes in `packages/shared/src/net/protocol.ts` (`ClientMessages`,
  `ServerMessages`), social in `net/social.ts`, voice in `net/voice.ts`; the zod schema sits next to
  each server handler. Change the type and the schema together. Rate-limit new client messages
  (inventory and quest ops allow 5/s) and answer refusals with `denied {action, reason}`.
- **Close codes:** `CLOSE` in `packages/shared/src/net/social.ts`: 4100 elsewhere, 4101 merged,
  4102 banned, 4103 logged out, 4104 kicked, 4105 storage (saving is failing; the client backs off
  and shows a notice) (Colyseus reserves 4000–4010). Add new codes there and
  handle them in `Game.onRoomClosed` (`apps/client/src/game/Game.ts`).

## Tests

- Vitest projects `shared`, `server` (20 s timeout, forks), `client` (node environment, 30 s; no
  DOM, so test pure logic). Tests sit next to the source as `*.test.ts`; server integration tests
  are in `apps/server/test`.
- `apps/server/test/helpers.ts`: `startServer()` runs the game in-process with memory stores;
  `joinAs(game, userId, body)` joins with a dev token `dev:<userId>:<name>[:admin|:loadtest]` and
  grants the travel ticket; `waitFor(cond)` polls. `auth-helpers.ts` drives the real Better Auth
  flows; `quest-helpers.ts` has bots for missions and eggs.
- Drive the real code path (send the client message, let the system emit the event) rather than
  emitting synthetic bus events. Wait on conditions, not fixed sleeps. Restore any mutated tuning
  constant in `finally` or `afterEach`.

## Process

- Work in your own git worktree and branch, inside the paths your brief gives you; small commits.
  Each commit message ends with the `Co-Authored-By:` line your harness gives you.
  `packages/shared` changes go through the builder (SPEC §9.1) and stay additive.
- Reviews are saved as `docs/reviews/<date>-<topic>-<model>.md`. The reviewers report; the builder decides.
- Secrets live in env settings and `~/.config/firstlight/.env`; code, docs and command output never
  contain them. Docs use repo-relative paths.
- **IP line:** everything is original: no franchise names or near-misses, no ripped models, sounds,
  music or logos (DECISIONS "IP line"). Check new names against `docs/content.md` §10 and new
  character looks against the avoid lists in §8.2.
- Third-party files: only sources `docs/content.md` §9 allows (CC0, CC BY, OFL), each recorded in
  `docs/ASSETS.md` with author, source URL, licence, date, changes and hash. ElevenLabs outputs never
  go in git.
- Easter-egg solutions are spoilers: keep new ones out of user-facing text and comments.

## Agent skills

- Issue tracker: GitHub Issues via `gh` (`docs/agents/issue-tracker.md`).
- Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`
  (`docs/agents/triage-labels.md`).
- Domain docs: `docs/agents/domain.md`. This repo's decision log is `docs/DECISIONS.md`.

# FIRSTLIGHT

A free multiplayer open world in the browser: three planets and a hub, a crowd of strangers, one
life. Die, and everything you carried drops into a glowing pile for anyone to take.

Play: https://firstlight.one4all.dev (desktop browser, keyboard and mouse, WebGPU or WebGL2).

## What's in it

- Planets you can walk around (they are real spheres), portals between them, and a safe hub, Portus.
- Server-authoritative combat: melee, bows, guns, grenades, a shield bubble and a heal, with PvE
  creatures, camps and three bosses that need a group.
- Death drops your inventory in a pile; you start over at level 1 with your account's medals.
- Missions, medals, hidden Easter eggs and a Hall of Firsts.
- Proximity voice (WebRTC over a TURN relay), a phrase wheel, parties, blocking and reporting.
- Breakable props, weather and a day/night cycle, horses, photo mode.
- Guests play instantly; an email code saves the account.

## Run it locally

Needs Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev          # server on :2567, client on :5173
pnpm typecheck
pnpm test         # every Vitest project
```

`AGENTS.md` is the guide to the code: layout, commands, the code rules (erasable TypeScript on the
server), extension points and tests.

## How it's built

- `apps/client`: Vite, three.js (WebGPU renderer with TSL node materials, WebGL2 fallback), plain DOM UI.
- `apps/server`: Node 24, Express, Colyseus, Better Auth, SQLite.
- `packages/shared`: deterministic code both sides use (terrain, content catalogues, protocol).
- `apps/assets-worker`: a Cloudflare Worker for large assets.

The game was built by AI agents (Claude Opus 5.5 with Codex reviewers) from the spec in
`docs/SPEC.md`; decisions are in `docs/DECISIONS.md`, progress in `docs/STATUS.md`, and the code
reviews in `docs/reviews/`.

## Licences

- Code: MIT (`LICENSE`).
- Our own art, music and sound: CC BY 4.0 (`LICENSE-ART`), attribution "FIRSTLIGHT contributors".
- Third-party assets and libraries: `docs/ASSETS.md` and `apps/client/public/THIRD-PARTY-NOTICES.md`.

# FIRSTLIGHT

A free multiplayer open world in the browser by Rostyslav Dzhohola: three planets and a hub, a crowd
of strangers, one life. Die, and everything you carried drops into a glowing pile for anyone to take.
Humans and AI agents play the same world under the same rules.

Play: https://firstlight.one4all.dev (desktop browser, keyboard and mouse, WebGPU or WebGL2; phones
can try it on the Low tier with touch controls, experimental).

## What's in it

- Planets you can walk around (they are real spheres), portals between them, and a safe hub, Portus,
  with a short tutorial for the first visit.
- Nine wild places off the paths, three on each planet (watchtowers, ruins, a shrine, a cave and a
  landmark seen from afar), each with a guardian, its pack and a chest that opens when the guardian
  falls; finding one pays XP once per life.
- Server-authoritative combat: melee, bows, guns, grenades, a shield bubble and a heal, a spellbook
  of four spells, PvE creatures, camps and three bosses that need a group.
- Third person or first person (V).
- Death drops your inventory in a pile; you start over at level 1 with your account's medals.
- Missions, medals, hidden Easter eggs, a Hall of Firsts and a three-planet hunt for the Gleam Vault.
- Residents: AI townsfolk you can talk to (`tools/agent/residents.ts` starts them), labelled as AI
  like every agent.
- A phrase wheel, parties, blocking and reporting; proximity voice is built but switched off for now.
- Breakable props, weather and a day/night cycle, horses, photo mode.
- Guests play instantly; an email code saves the account.

<!-- LEAD: tonight's later lanes, to fold into the list above as they merge into night/integration.
     Delete this block once it is done.
- [ ] play: the relaxed tutorial (one click finishes the attack lesson), a missions panel you can
      collapse and a tracked mission, a compass with the tracked mission, home and the nearest pad,
      level tags on creatures, health regeneration out of combat.
- [ ] sky: planets that orbit, and a moon you can visit.
- [ ] weapons: the new weapon models.
-->

## AI agents can play

The worlds are open to AI agents as well as people: an agent joins the same rooms through the same
server rules, with no browser or GPU, reads the world as text or JSON and acts through commands like
"walk to the guide", "fight that creature", "take the missions". Agents are labelled: everyone sees
an `AI` chip on their name, and the leaderboards stay people's.

- Nothing to install: the game server hosts the agent tools. Claude Code:
  `claude mcp add --transport http firstlight https://api.firstlight.one4all.dev/mcp`; Codex:
  `codex mcp add firstlight --url https://api.firstlight.one4all.dev/mcp`; or plain HTTP at
  `/api/agent/join`, `/observe` and `/act`. The home page's "Bring your agent" block has the lines.
- A local MCP server instead (Claude Code, Codex, …): `node tools/agent/mcp.ts`.
- A model with a shell: `node tools/agent/serve.ts`, then `node tools/agent/fl-agent.mjs observe`.
- A script: `import { FirstlightAgent } from "@firstlight/agent-kit"`; a full example that hunts,
  casts, heals, loots and finishes two missions with no model is `tools/agent/examples/hunter.ts`.
- A lived-in world: `node tools/agent/residents.ts --count 8` starts scripted residents (hunters,
  wanderers, traders, hunt-chasers), each labelled as an AI.

`docs/agents/playing.md` has the quick start, every tool, the observation format, the limits and
the etiquette.

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
- `packages/agent-kit` and `tools/agent`: the headless player for AI agents and its MCP, HTTP and
  command-line front ends.

Made by Rostyslav Dzhohola. Most of the code is written by AI agents (Claude and Codex models, each
reviewing the other's work) from the spec in `docs/SPEC.md`; decisions
are in `docs/DECISIONS.md`, progress in `docs/STATUS.md`, and the code reviews in `docs/reviews/`.

How we know it works for a stranger: the server keeps its own first-session funnel and the client's
error reports (no third-party analytics), and `/stats` shows the launch numbers from issue #85
against their targets; `docs/metrics.md` lists every measure and how to take it.

## Licences

- Code: MIT (`LICENSE`).
- Our own art, music and sound: CC BY 4.0 (`LICENSE-ART`), attribution "FIRSTLIGHT contributors".
- Third-party assets and libraries: `docs/ASSETS.md` and `apps/client/public/THIRD-PARTY-NOTICES.md`.

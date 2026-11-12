# Playing FIRSTLIGHT as an AI agent

AI agents play in the same worlds as people, by the same server rules: an agent joins a room through
`POST /api/play` like a browser does, the server validates its movement and decides every hit, drop
and reward. There is no browser and no GPU involved: the agent reads the world as text or JSON and
acts through high-level commands (walk there, fight that, take the missions).

Three ways in, all on top of one library:

| You have | Use | Start |
| --- | --- | --- |
| A model with MCP tools (Claude Code, Codex, any MCP client) | the MCP server | `node tools/agent/mcp.ts` |
| A model with only a shell | the HTTP bridge and its CLI | `node tools/agent/serve.ts`, then `node tools/agent/fl-agent.mjs …` |
| Your own script | the library | `import { FirstlightAgent } from "@firstlight/agent-kit"` |

Everything needs Node 24 and a checkout of this repo with `pnpm install` done. The `.ts` files run
directly (`node file.ts`), nothing is built.

Agents are **labelled**: the join request says "I am an agent", the server marks the character, and
every player sees an `AI` chip on its nameplate and in the Tab player list. See
[Labelling and limits](#labelling-and-limits).

## Quick start (local)

Start the game (`pnpm dev`: server on :2567, client on :5173), then pick one.

### MCP: Claude Code

```sh
claude mcp add firstlight -e FL_URL=http://localhost:2567 -e FL_AGENT_NAME=Scout_7 -- node "$PWD/tools/agent/mcp.ts"
```

or in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "firstlight": {
      "command": "node",
      "args": ["tools/agent/mcp.ts"],
      "env": { "FL_URL": "http://localhost:2567", "FL_AGENT_NAME": "Scout_7" }
    }
  }
}
```

### MCP: Codex

In `~/.codex/config.toml` (use the absolute path of your checkout):

```toml
[mcp_servers.firstlight]
command = "node"
args = ["/absolute/path/to/firstlight/tools/agent/mcp.ts"]
env = { FL_URL = "http://localhost:2567", FL_AGENT_NAME = "Scout_7" }
```

Then tell the model: "Join FIRSTLIGHT and reach level 3." The server's `instructions` (the playbook
below) tell it how the game works; the first call is `firstlight_join`.

### Shell: the HTTP bridge

```sh
FL_URL=http://localhost:2567 node tools/agent/serve.ts &   # the bridge, on 127.0.0.1:7361
node tools/agent/fl-agent.mjs join --name Scout_7 --starter unit7
node tools/agent/fl-agent.mjs observe
node tools/agent/fl-agent.mjs move portal:arcadia --sprint
node tools/agent/fl-agent.mjs travel --portal arcadia
node tools/agent/fl-agent.mjs move guide
node tools/agent/fl-agent.mjs missions take
node tools/agent/fl-agent.mjs observe --detail full
node tools/agent/fl-agent.mjs attack n12 --seconds 20
node tools/agent/fl-agent.mjs quit
```

### No model at all: the example hunter

```sh
node tools/agent/examples/hunter.ts --url http://localhost:2567 --seconds 300
```

It walks from the Portus town through the portal to Arcadia, takes the first hunt mission from the
guide, leaves the outpost, kills Hopbits, drinks tonics, retreats when hurt, picks up loot, and
stops when the mission is done. It prints a line per decision and ends with `RESULT {…}` (kills,
XP, mission progress, and `corrections`: movement the server refused, which should be 0). It is also
the kit's end-to-end test (`apps/server/test/agent-tools.test.ts`).

### Settings (environment)

| Variable | Meaning | Default |
| --- | --- | --- |
| `FL_URL` | Game server (API) origin | `http://localhost:2567` |
| `FL_AUTH_URL` | Where sign-in (`/api/auth/*`) answers, when it isn't `FL_URL`: the site origin on a hosted game | `FL_URL` |
| `FL_AUTH_ORIGIN` | The `Origin` header for sign-in requests, if a server refuses the default (it trusts its site's origin only) | `FL_AUTH_URL` |
| `FL_AGENT_NAME` | Display name to ask for (3-16 letters, digits, `_`) | a generated `Wanderer-1234` |
| `FL_AGENT_HOME` | Where guest sessions are kept, one file per server and name | `~/.firstlight/agents` |
| `FL_AGENT_SESSION` | One session file, or `none` for a fresh guest every run | (see `FL_AGENT_HOME`) |
| `FL_DEV` | `1`: dev guest tokens instead of sign-in (a server started with `ALLOW_DEV_GUESTS=1`) | off |
| `FL_AGENT_PORT` | The HTTP bridge's port | `7361` |

The session file holds the guest's session cookie. It **is** the character (level, items, medals):
keep it private, and keep it if you want the same character next time.

A hosted game: `FL_URL` is the API host and `FL_AUTH_URL` the site (for the public game:
`FL_URL=https://api.firstlight.one4all.dev FL_AUTH_URL=https://firstlight.one4all.dev`). Agents are
only let in where the server's `AGENTS_ENABLED` is on; on the public game they are off until the
owner turns them on, and the join answers `agents off`.

## How the game works (the playbook the MCP server sends)

- You play one character next to people; your name carries an `AI` chip.
- Loop: join once, then observe, act, repeat. Every action returns its result, a one-line status and
  the events since your last look.
- Positions are distances in metres and compass bearings (0 = north, 90 = east). Ids come from the
  observation.
- Safe zones (the Portus town, the walled outpost round each planet's main pad, 12 m round every
  pad): nobody can fight there; shops and guides are inside.
- To level up: in Portus walk to a portal and travel to Arcadia (enemy levels 1-7; Hollowmere 6-13,
  Meridian 12-20). There: take missions from the guide, leave the outpost, fight creatures of about
  your level, pick up loot, heal with tonics, go back to safety when hurt.
- Dying costs the character: a new life starts at level 1 (medals stay). Retreat early.

## Tools (MCP and HTTP)

The MCP tool `firstlight_<name>` is `POST /<name>` on the bridge and `fl-agent.mjs <name>` on the
command line; arguments are the same JSON. Unknown or out-of-range arguments are refused before
anything reaches the game. Results are JSON with `ok`; a refusal has `reason` (short, stable) and
usually `hint` (what to do instead). One action runs at a time; `stop` interrupts it.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `join` | `url?`, `authUrl?`, `name?`, `starter?` (`hexwick` magic bolts, `ash` sword, `kappa` staff, `unit7` carbine, `ninja` kunai), `body?`, `dev?` | Enter the world as a guest flagged as an agent. Once. |
| `observe` | `detail?` (`summary`, `full`) | The text summary; `full` adds the JSON observation. |
| `move` | `target` **or** `bearing` + `distance`; `sprint?`, `within?`, `seconds?`, `untilHit?` | Walk there and wait. Steers round walls, trees and rocks, uses the gate of a walled zone. |
| `stop` | | End the walk or fight in progress. |
| `attack` | `target`; `seconds?` (20), `retreatBelow?` (0.3), `pvp?` | Fight a creature until it dies, time is up, or HP falls under `retreatBelow`. |
| `dodge` | `bearing?` | Roll 4.5 m. Every 1.3 s. |
| `interact` | `target?` | The E key: pick up the pile in reach, talk to the guide, open the shop, take a mission item. |
| `missions` | `action` (`list`, `take`); `ids?` | Your missions and the guide's offers; take them (within 3 m of the guide). |
| `shop` | `action` (`list`, `buy`, `sell`); `item?`, `tier?`, `qty?`, `slot?` | Trade at the till you stand at. |
| `item` | `action` (`select`, `equip`, `use`, `reload`); `slot?`, `item?` | Hold a hotbar slot, equip from the backpack, drink a tonic, reload. |
| `travel` | `portal` (a body) **or** `pad` (a number) | Step through the portal you stand at, or fast travel between discovered pads. |
| `say` | `phrase` | One of the game's fixed phrases (there is no free chat). |
| `respawn` | `starter?` | After death: a new life in Portus. |
| `cast` | `spell`; `target?`, `bearing?` | Reserved for the spellbook (see below). |
| `leave` | `logout?` | Leave the game. |

Move targets: an id from the observation (a creature, a player, a loot pile), or `guide`, `shop`,
`portal:<body>`, `pad:<n>`, `pad` (nearest), `gate`, `safe` (the nearest way into a safe zone),
`mission:<id>` (where that mission sends you).

### HTTP bridge

`node tools/agent/serve.ts [--port 7361] [--join] [--name N] [--starter S] [--url U] [--dev]`,
bound to `127.0.0.1` only. It plays a character for whoever can reach it: never expose it. Requests
with an `Origin` header (web pages) are refused.

| Request | Answer |
| --- | --- |
| `GET /` | What this is, the playbook, and every tool with its JSON schema |
| `GET /observe[?detail=full]` | The observation |
| `POST /<tool>` with a JSON body | The tool's result (`404` for an unknown tool) |
| `POST /quit` | Leaves the game and stops the bridge |

```sh
curl -s localhost:7361/observe
curl -s -X POST localhost:7361/move -d '{"bearing": 90, "distance": 40, "sprint": true}'
curl -s -X POST localhost:7361/attack -d '{"target": "n12"}'
```

## The observation

`observe()` returns one object. The `summary` is the same content as a few lines of text, at most
1.5 KB; the whole object is a few KB. Distances are metres (along the ground for places, straight
for creatures and players); bearings are compass degrees from where you stand.

```
Scout_7 [AI] L1 on arcadia: HP 100/100, XP 0/50, 0 coins. SAFE zone (outpost): no fighting here.
Weapon Pocket Carbine (slot 0, ranged, 25 m 24/24). Facing N.
Creatures (2): n14 Hopbit L1 22/22hp 31 m NE (48°) hostile *mission; n15 Hopbit L1 22/22hp 34 m NE (52°) hostile.
Places: guide Lark 5 m E (97°); shop Dawnpad Trading Post (Pell Hayward) 14 m SW (230°); portal to portus 9 m N (0°); pad 0 Dawnpad 1 m N (12°).
Missions: A1 Pest Control 0/8: Kill 8 Hopbits inside Clover Fields -> 147 m NE (54°).
Events: Mission accepted: Pest Control — Kill 8 Hopbits inside Clover Fields.
```

| Field | Contents |
| --- | --- |
| `status` | `playing`, `dead`, `reconnecting`, `offline` |
| `self` | `id`, `name`, `agent` (always true), `body`, `pos` `[x, y, z]`, `heading`, `hp`, `maxHp`, `level`, `xp`, `xpToNext`, `coins`, `zone` (`safe` or `danger`), `zoneKind` (`town`, `outpost`, `pad`, `wild`), `dead`, `swimming`, `inCombat`, `protectedFor` (seconds of arrival protection), `weapon` `{id, name, slot, kind, range, mag?, magSize?}`, `hotbar[]` and `backpack[]` of `{slot, id, name, tier, qty, mag?}`, `cooldowns` `{attack, reload, overheat, dodge, tonic}` in ms |
| `creatures[]` | nearest 8: `id`, `kind`, `name`, `level`, `hp`, `maxHp`, `dist`, `bearing`, `hostile`, `boss`, `onMe` (attacking you now), `mission` (a kill counts for your hunt) |
| `players[]` | nearest 8: `id`, `name`, `level`, `dist`, `bearing`, `agent` (an AI or a person), `dead` |
| `piles[]` | loot on the ground: `id`, `dist`, `bearing`, `coins`, `items`, `yours` |
| `pads[]` | nearest 3 fast-travel pads: `id` (`pad:<n>`), `name`, `dist`, `bearing`, `known` |
| `portals[]` | `id` (`portal:<body>`), `to`, `dist`, `bearing` |
| `guide` | the mission giver of a planet (null on Portus): `name`, `dist`, `bearing` |
| `shops[]` | `name`, `dist`, `bearing`, `inReach` |
| `safety` | the nearest way into a safe zone: `name`, `dist`, `bearing` |
| `missions[]` | yours: `id`, `name`, `objective`, `progress`, `goal`, `done`, `where?` `{dist, bearing, what}` |
| `offers[]` | what the guide here still has: `id`, `name`, `objective`, `levels` |
| `events[]` | since your previous observation: `{ago, type, text}`; types `hit`, `hurt`, `kill`, `death`, `toast`, `denied`, `mission`, `shop`, `info`, `phrase`, `level` |

## The library

```ts
import { FirstlightAgent } from "@firstlight/agent-kit";

const agent = new FirstlightAgent();
await agent.connect({ url: "http://localhost:2567", name: "Scout_7", starter: "unit7", sessionFile: "./scout.session.json" });
console.log(agent.observe().summary);
```

`connect` throws an `AgentError` (`code`: `agents off`, `agent limit`, `version`, `unauthorized`, …)
when the server refuses the join. Every action resolves with `{ ok, reason?, hint?, … }` and never
throws for a game reason.

| Call | Example | Notes |
| --- | --- | --- |
| `connect(options)` | `connect({ url, name, starter: "kappa", look: 0, palette: 2 })` | Guest sign-in, flagged as an agent. `token: "dev:<id>:<name>"` on a dev server; `body` picks a world (the server redirects to where the character is). Reconnects on its own after a drop. |
| `observe({ peek? })` | `agent.observe().creatures[0]` | `peek: true` leaves the events unread. |
| `moveTo(target, { sprint?, within?, seconds?, stopWhenHit? })` | `moveTo("guide")`, `moveTo({ bearing: 90, distance: 40 })`, `moveTo("n14", { within: 10 })`, `moveTo({ pos: [x, y, z] })` | Result: `walked`, `remaining`, `seconds`, `corrections`. Reasons: `timeout`, `blocked`, `target gone`, `hurt`. |
| `stop()` | | The action in progress resolves as `cancelled`. |
| `lookAt(target \| bearing)` | `lookAt(270)` | Turns the body. |
| `attack(id, { seconds?, untilDead?, retreatBelow?, pvp? })` | `attack("n14", { retreatBelow: 0.35 })` | Closes to weapon range, aims the way the server expects (from the head, leading a moving target, lifting for a projectile's drop), respects rate, reload and overheat. Result: `killed`, `xp`, `coins`, `hp`. Reasons: `safe zone`, `time`, `low hp`, `swimming`, `level gate`. |
| `dodge(bearing?)` | `dodge(180)` | The roll's extra speed is the one the server allows per 1.2 s. |
| `selectSlot(n)` | `selectSlot(1)` | Hotbar 0-3. |
| `equip(slot \| itemId)` | `equip("sunbrand")` | Moves it from the backpack if needed. |
| `useItem(slot \| itemId)` | `useItem("tonic_small")` | Tonics: one every 8 s. |
| `reload()` | | |
| `interact(target?)` | `interact()`, `interact("a2_bell")` | Piles first, like the client's E. |
| `takeMissions(ids?)` | `takeMissions(["A1"])` | Within 3 m of the guide. |
| `shop()`, `buy(id, { tier?, qty? })`, `sell(slot \| id, qty?)` | `buy("tonic_small", { qty: 3 })` | At a till. |
| `travel(pad)` | `travel(4)` | From any pad to a discovered one, out of combat. |
| `enterPortal(body)` | `enterPortal("arcadia")` | At the portal, out of combat. Joins the other world. |
| `phrase(n \| text)` | `phrase("Thanks")` | `Truce?`, `Help!`, `Follow me`, `Boss here`, `Thanks`, `GG`. |
| `respawn({ starter? })` | `respawn({ starter: "ash" })` | Only while dead. |
| `skipTutorial()` | | Skips the Portus training dummies (which pay 50 XP when done). |
| `cast(spell, { targetId?, bearing? })` | `cast("spark", { targetId: "n14" })` | Reserved, see below. |
| `close({ logout? })` | `close({ logout: true })` | In a safe zone the body leaves at once; elsewhere it stays 30 s unless you log out (about 10 s standing still). |

`agent.events` holds the last 60 events, `agent.corrections` counts movement the server refused,
`agent.stalls` the ticks the agent stood still because the server had gone quiet.

### Why it doesn't rubber-band

The kit runs the client's movement rules on the shared terrain and solids (`packages/shared/src/planet`),
sends 20 inputs a second, and never moves further in a step than run or sprint speed allows for the
time since the last input it sent. The server pays for at most 0.25 s of movement between two
inputs it handles, so when it stalls (no state patch for 170 ms) the agent stands until patches flow
again instead of running on and being snapped back.

### `cast` is a stub

The spellbook (a `cast` client message with a spell id and an aim) is being added in parallel.
`agent.cast(spell, aim)` sends `cast { spell, ox, oy, oz, dx, dy, dz, targetId?, t }` (origin at the
head, unit direction) and reports `sent`; until the server knows the message nothing happens in the
world. The final message shape is matched at integration, in `packages/agent-kit/src/agent.ts`.

## Labelling and limits

- **The flag.** `POST /api/play` with the header `x-firstlight-agent: 1` (or `"agent": true` in the
  body) seats the player as an agent. A guest account that does this is an agent's from then on.
  The kit always sends it.
- **What others see.** `PlayerState.agent` is synced to every client: an `AI` chip on the nameplate
  and in the Tab list.
- **What agents are kept out of.** The levels and medals boards, the Hall of Firsts, the home page's
  "online now" names and count, and the play statistics are people's. `/api/online` reports agents
  apart (`{ online, agents }`); `/stats` shows their sessions on their own line.
- **The switch.** `AGENTS_ENABLED`: on by default outside production, **off in production unless set
  to `1`**; `0` turns agents off anywhere. Refusal: `403 { error: "agents off" }`.
- **The caps.** At most `AGENTS_PER_IP` (default 4) agents at once from one address and
  `AGENTS_PER_ROOM` (default 8, of 40 seats) in one copy of a world; a full copy sends the agent to
  another copy. Refusal: `403 { error: "agent limit", message }`. Loopback counts like any address:
  raise `AGENTS_PER_IP` for a local swarm.
- **This is honest labelling, not security.** Nothing can tell a script that leaves the flag out
  from a person at a keyboard: it plays as an unlabelled player under the same server rules. The
  flag exists so that well-behaved agents are visible, and so that people's boards stay people's.

## Etiquette

- Don't attack players. `attack` refuses a player unless `pvp` is set; use it only against a player
  who attacked you first.
- Don't take loot piles that aren't `yours` while their owner is near.
- Don't crowd the guide, the shop or the portals; step away when done.
- One character per session file; a handful of agents per address at most (the cap enforces it).
- Leave cleanly: `leave` inside a safe zone, or with `logout`.

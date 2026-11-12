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

It walks from the Portus town through the portal to Arcadia, takes the first hunt mission and Kite
Season (a collect) from the guide, leaves the outpost, gathers the five kite panels in the meadow,
kills Hopbits, drinks tonics, retreats when hurt, picks up loot, and stops when both missions are
done. It casts where it pays: Frostbloom when two or more creatures are on top of it, the Glasswing
Ward when hurt in a fight, Skipstep to break away before a retreat. It prints a line per decision
and ends with `RESULT {…}` (kills, XP, mission progress, `casts`, and `corrections`: movement the
server refused, which should be 0). It is also the kit's end-to-end test
(`apps/server/test/agent-tools.test.ts`). `--collect none` skips Kite Season.

### A world with residents

`tools/agent/residents.ts` starts several scripted characters at once: see [Residents](#residents).

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

Play tokens are bound to that session: the server takes a token, and keeps the seat it bought, only
while the session that issued it exists. The kit follows that. A token is never used past its
session: when the game answers 401 the kit drops it and asks the session for a new one. If the
session itself is gone (signed out, expired, pruned), then:

- at `connect` the kit signs in as a new guest and says so: the result carries `newGuest: true`,
  because that is another character;
- for a character already in play (a reconnect after a drop, a portal, a rebirth) it never swaps in
  a new guest: the agent goes `offline` with the event "the guest session ended…", and you connect
  again when you want the new one.

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
- Spells cost aether and unlock by level: Skipstep 1 (a blink out of a bad fight), Frostbloom 3
  (when surrounded), Wishfall 6, Glasswing Ward 9 (a shell when hurt).
- Race, defend and collect missions are played with `trial`. The public hunt, the Three Gleams:
  Sela Marchbank in Portus gives trials T1 (Arcadia, levels 4-7), T2 (Hollowmere, 9-12) and T3
  (Meridian, 14-17); all three open the Gleam Vault beside her.
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
| `dodge` | `bearing?` | Roll 4.5 m. Every 1.0 to 1.35 s, by starter. |
| `interact` | `target?` | The E key: pick up the pile in reach, talk to the guide or to Sela Marchbank, open the shop, take a mission item, light a beacon, open the Gleam Vault. |
| `missions` | `action` (`list`, `take`); `ids?` | Your missions and the offers of the giver here; take them (within 3 m of the guide, or of Sela Marchbank in Portus). |
| `trial` | `mission` (`A4`, `H4`, `T1`, `T2`, `T3`); `seconds?`, `retreatBelow?` | Play a race, defend or collect mission start to finish (see [Missions and trials](#missions-and-trials)). |
| `shop` | `action` (`list`, `buy`, `sell`); `item?`, `tier?`, `qty?`, `slot?` | Trade at the till you stand at. |
| `item` | `action` (`select`, `equip`, `use`, `reload`); `slot?`, `item?` | Hold a hotbar slot, equip from the backpack, drink a tonic, reload. |
| `travel` | `portal` (a body) **or** `pad` (a number) | Step through the portal you stand at, or fast travel between discovered pads. |
| `say` | `phrase` | One of the game's fixed phrases (there is no free chat). |
| `respawn` | `starter?` | After death: a new life in Portus. |
| `cast` | `spell` (`skipstep`, `frostbloom`, `wishfall`, `glasswing`); one of `target`, `bearing` (+ `distance`), `pos` | Cast a spell (see [Spells](#spells)). |
| `leave` | `logout?` | Leave the game. |

Move targets: an id from the observation (a creature, a player, a loot pile, a ring or beacon), or
`guide`, `curator` (Sela Marchbank), `vault`, `shop`, `portal:<body>`, `pad:<n>`, `pad` (nearest),
`gate`, `safe` (the nearest way into a safe zone), `mission:<id>` (where that mission leads now: the
hunting ground, the next ring, the beacon, the nearest piece left).

### HTTP bridge

`node tools/agent/serve.ts [--port 7361] [--join] [--name N] [--starter S] [--url U] [--dev]`,
bound to `127.0.0.1` only. It plays a character for whoever can reach it: never expose it. Requests
with an `Origin` header (web pages) or under another hostname are refused.

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
Aether 100/100. Spells: skipstep ready, frostbloom L3, wishfall L6, glasswing L9.
Creatures (2): n14 Hopbit L1 22/22hp 31 m NE (48°) hostile *mission; n15 Hopbit L1 22/22hp 34 m NE (52°) hostile (Mira's fight).
Places: guide Lark 5 m E (97°); shop Dawnpad Trading Post (Pell Hayward) 14 m SW (230°); portal:portus 9 m N (0°); pad:0 Dawnpad 1 m N (12°).
Missions: T1 The Swift Gleam 3/8 [race running 41s left]: run through the rings in order, 5 to go -> t1_ring_4 62 m E (88°); A1 Pest Control 0/8: Kill 8 Hopbits inside Clover Fields -> 147 m NE (54°).
Lark offers: A2 The Lost Bell (find, L2-4), A4 Kite Season (collect, L1-3).
Events: Mission accepted: Pest Control — Kill 8 Hopbits inside Clover Fields.
```

Over the size limit the least urgent lines go first (offers, places, loot, players, old events);
you, your weapon, what is attacking and a trial with a clock running stay.

| Field | Contents |
| --- | --- |
| `status` | `playing`, `dead`, `reconnecting`, `offline` |
| `self` | `id`, `name`, `agent` (always true), `body`, `pos` `[x, y, z]`, `heading`, `hp`, `maxHp`, `level`, `xp`, `xpToNext`, `coins`, `zone` (`safe` or `danger`), `zoneKind` (`town`, `outpost`, `pad`, `wild`), `dead`, `swimming`, `inCombat`, `protectedFor` (seconds of arrival protection), `weapon` `{id, name, slot, kind, range, mag?, magSize?}`, `hotbar[]` and `backpack[]` of `{slot, id, name, tier, qty, mag?}`, `cooldowns` `{attack, reload, overheat, dodge, tonic}` in ms, `starter` and its own `speed` `{run, sprint, dodgeCooldown}`, `spells` `{aether, max, ward? {hp, left}, list[]}` with each spell's `id`, `name`, `level` (unlock), `cost`, `cooldown` (s), `unlocked`, `readyIn` (ms), `ready` |
| `creatures[]` | nearest 8: `id`, `kind`, `name`, `level`, `hp`, `maxHp`, `dist`, `bearing`, `hostile`, `boss`, `onMe` (attacking you now), `mission` (a kill counts for your hunt), `claimedBy?` `{name, agent}` (another player is fighting it: leave it to them) |
| `players[]` | nearest 8: `id`, `name`, `level`, `dist`, `bearing`, `agent` (an AI or a person), `dead` |
| `piles[]` | loot on the ground: `id`, `dist`, `bearing`, `coins`, `items`, `yours` |
| `pads[]` | nearest 3 fast-travel pads: `id` (`pad:<n>`), `name`, `dist`, `bearing`, `known` |
| `portals[]` | `id` (`portal:<body>`), `to`, `dist`, `bearing` |
| `guide` | the mission giver of a planet (null on Portus): `name`, `dist`, `bearing` |
| `shops[]` | `name`, `dist`, `bearing`, `inReach` |
| `safety` | the nearest way into a safe zone: `name`, `dist`, `bearing` |
| `missions[]` | yours: `id`, `name`, `type` (`hunt`, `find`, `reach`, `race`, `defend`, `collect`), `objective`, `progress`, `goal`, `done`, `where?` `{dist, bearing, what, id?}` (a race: the next ring; a collect: the nearest piece left), `on?` (the body it is played on, when not this one), `trial?` `{state, left?, limit, remaining, next, failed?}` for race, defend and collect |
| `offers[]` | what the giver on this body still has: `id`, `name`, `type`, `objective`, `levels`, `from` (the guide, or Sela Marchbank) |
| `hunt` | the Three Gleams: `name`, `gleams` won this life, `of` 3, `vaultOpened`, and in Portus `curator` and `vault` as places |
| `events[]` | since your previous observation: `{ago, type, text}`; types `hit`, `hurt`, `kill`, `death`, `toast`, `denied`, `mission`, `shop`, `info`, `phrase`, `level`, `spell`, `trial` |

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
| `attack(id, { seconds?, untilDead?, retreatBelow?, pvp?, yieldTo? })` | `attack("n14", { retreatBelow: 0.35, yieldTo: "people" })` | Closes to weapon range, aims the way the server expects (from the head, leading a moving target, lifting for a projectile's drop), respects rate, reload and overheat. Result: `killed`, `xp`, `coins`, `hp`. Reasons: `safe zone`, `time`, `low hp`, `swimming`, `level gate`, `yielded` (with `yieldTo`: a person, or anyone, hit the same creature; the kill is theirs). |
| `dodge(bearing?)` | `dodge(180)` | The roll's extra speed is the one the server allows per roll; the cooldown is the starter's. Not while slowed. |
| `selectSlot(n)` | `selectSlot(1)` | Hotbar 0-3. |
| `equip(slot \| itemId)` | `equip("sunbrand")` | Moves it from the backpack if needed. |
| `useItem(slot \| itemId)` | `useItem("tonic_small")` | Tonics: one every 8 s. |
| `reload()` | | |
| `interact(target?)` | `interact()`, `interact("a2_bell")` | Piles first, like the client's E. |
| `takeMissions(ids?)` | `takeMissions(["A1"])` | Within 3 m of the giver you stand at: the guide, or Sela Marchbank in Portus. |
| `playTrial(id, { seconds?, retreatBelow?, stopWhenHit? })` | `playTrial("A4")` | A race, defend or collect mission start to finish. Result: `done`, `progress`, `goal`, `seconds`, `hp`. Reasons: `failed: time`, `failed: left`, `dead`, `blocked`, `timeout`, `hurt`, `wrong body`, `not accepted`. |
| `shop()`, `buy(id, { tier?, qty? })`, `sell(slot \| id, qty?)` | `buy("tonic_small", { qty: 3 })` | At a till. |
| `travel(pad)` | `travel(4)` | From any pad to a discovered one, out of combat. |
| `enterPortal(body)` | `enterPortal("arcadia")` | At the portal, out of combat. Joins the other world. |
| `phrase(n \| text)` | `phrase("Thanks")` | `Truce?`, `Help!`, `Follow me`, `Boss here`, `Thanks`, `GG`. |
| `respawn({ starter? })` | `respawn({ starter: "ash" })` | Only while dead. |
| `skipTutorial()` | | Skips the Portus training dummies (which pay 50 XP when done). |
| `cast(spell, { targetId?, bearing?, distance?, pos? })` | `cast("wishfall", { targetId: "n14" })` | A spell from the spellbook. Result: `aether` left, and per spell `moved`, `slowed`, `landsIn`, `shell`. Reasons: `locked`, `cooldown`, `aether`, `safe zone`, `protected`, `swimming`, `blocked`. |
| `close({ logout? })` | `close({ logout: true })` | In a safe zone the body leaves at once; elsewhere it stays 30 s unless you log out (about 10 s standing still). |

`agent.events` holds the last 60 events, `agent.corrections` counts movement the server refused
(a Skipstep's blink and a fast travel are not refusals), `agent.stalls` the ticks the agent stood
still because the server had gone quiet.

### Why it doesn't rubber-band

The kit runs the client's movement rules on the shared terrain and solids (`packages/shared/src/planet`),
sends 20 inputs a second, and never moves further in a step than run or sprint speed allows for the
time since the last input it sent. The server pays for at most 0.25 s of movement between two
inputs it handles, so when it stalls (no state patch for 170 ms) the agent stands until patches flow
again instead of running on and being snapped back.

Speeds are the character's own. Each starter has a row in `packages/shared/src/content/starters.ts`
(run and sprint speed, seconds between rolls) that the server validates against, and the kit walks
by the same row, read from the character the server seated: Hinoko sprints at 9.9 m/s and rolls
every 1.1 s, Brother Ash at 8.3 m/s and 1.35 s, Unit 7 at 9 m/s and 1.25 s. A slow the server puts
on the body (a chill, grave hands, another player's Frostbloom) is walked by too, and no roll is
tried while it lasts.

## Spells

Every character has aether (100, refilling 6 a second from 1.5 s after a cast) and four spells,
apart from the weapon in hand. `observe()` shows aether, which spells the level has unlocked and
which are ready; `cast` sends the game's own `cast` message and the server decides.

| Spell | Level | Aether | Cooldown | What it does | Aim |
| --- | --- | --- | --- | --- | --- |
| `skipstep` | 1 | 20 | 6 s | Blink up to 10 m along the ground. Walls, deep water and ledges stop it; a wall right ahead refuses it (`blocked`, nothing spent). | `bearing`, `target`, or the way you face |
| `frostbloom` | 3 | 30 | 10 s | Frost within 5 m of you: damage and a 3 s slow. It hurts players too. | none |
| `wishfall` | 6 | 45 | 14 s | A star on a ground point up to 30 m away; it lands 1.2 s later, 4 m across. You take half if you stand in it. | `target`, `bearing` + `distance`, or `pos` |
| `glasswing` | 9 | 35 | 18 s | A shell that soaks up damage for 4 s. | none |

```ts
await agent.cast("skipstep", { bearing: 180 });          // { ok: true, moved: 10, aether: 80 }
await agent.cast("wishfall", { targetId: "n14" });       // { ok: true, landsIn: 1.2, distance: 11.8 }
await agent.cast("frostbloom");                          // { ok: false, reason: "locked", hint: "Frostbloom unlocks at level 3 (you are level 1)" }
```

Skipstep moves the body on the server. The server answers with the new position, the kit takes it,
and the walk or fight in progress carries on from there; it is not counted in `corrections`.
Spells are refused in a safe zone, during arrival protection, while swimming, and (like attacks)
they tag you as in combat when they do damage.

## Missions and trials

`observe()` lists your missions with their `type`. Three of the six types have a clock or a count
the server runs as an attempt, and `missions[].trial` describes it:

| Type | How it runs | In the observation |
| --- | --- | --- |
| `race` (T1) | Running through ring 1 starts the clock; then every ring in order before it runs out. Out of time fails the attempt; ring 1 starts another. | `where`: the next ring (ring 1 while idle), `trial.left`: seconds on the clock, `trial.remaining`: rings to go |
| `defend` (H4, T2) | Interact with the beacon to light it, then stay within its ring while waves arrive. Outside, the clock waits (`paused`); outside for 10 s, or dying, fails. | `where`: the beacon, `trial.left`: seconds still to hold |
| `collect` (A4, T3) | Walk within 2.5 m of every piece. T3 is timed: the first shard starts a 4-minute clock, and running out drops the shards gathered. | `where`: the nearest piece left, `trial.remaining`: pieces to go |

`playTrial(id)` (the `trial` tool) plays one from wherever you stand on its body: it sprints the
ring route, walks the pieces nearest first, or lights the beacon, holds a spot well inside the ring
and fights what comes into it (drinking a tonic, and casting the ward and Frostbloom when it has
them). To do it step by step: `moveTo("mission:T1")` follows the attempt (the target moves on as
the server counts rings and pieces), and `interact("h4_lamp")` lights a beacon.

The Three Gleams is the public hunt. Sela Marchbank stands in Portus Plaza (`moveTo("curator")`)
and gives the trials T1 (a ring race on Arcadia, 220 m from the Highscore Hill pad), T2 (a beacon
in south Thornwood on Hollowmere) and T3 (shards on Meridian's salt flats); each is played on its
planet, so a trial held in Portus shows `on: "arcadia"`. With all three won this life,
`interact("vault")` opens the Gleam Vault beside her; before that it answers `vault locked`.

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
  another copy. Refusal: `403 { error: "agent limit", message }`. The address is the one the server's
  single client-address rule gives (the edge's `X-Real-IP`, else the socket; an IPv6 /64 counts as
  one address). Loopback counts like any address: raise `AGENTS_PER_IP` for a local swarm (see
  [Residents](#residents)).
- **This is honest labelling, not security.** Nothing can tell a script that leaves the flag out
  from a person at a keyboard: it plays as an unlabelled player under the same server rules. The
  flag exists so that well-behaved agents are visible, and so that people's boards stay people's.

## Residents

`tools/agent/residents.ts` makes a world feel lived in: it starts N scripted characters on the kit,
with no model behind them. Each joins flagged as an agent like any kit player, so it wears the
`AI` chip, stays off the people's boards and counts, and plays by every server rule.

```sh
node tools/agent/residents.ts --url http://localhost:2567 --count 8 --bodies portus,arcadia
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--url`, `--auth-url` | The game server, and where sign-in answers (as `FL_URL`, `FL_AUTH_URL`) | `http://localhost:2567` |
| `--count` | How many residents (the first N of the cast) | 4 |
| `--bodies` | Where they may live and go | `portus,arcadia` |
| `--roles` | Cycle these roles instead of the cast's own | the cast's |
| `--seconds` | Stop after this long | until Ctrl-C |
| `--cpu` | The process's CPU budget, as a share of one core: over it, everyone rests longer between steps | 0.5 |
| `--dev` | Dev guest tokens (a server started with `ALLOW_DEV_GUESTS=1`) | off |

The cast, in order: Brindle_Oake (hunter), Tamsin_Hollis (wanderer), Marlo_Thistle (trader),
Juniper_Fenn (hunt-chaser), then Garnet_Moss, Hesper_Dunn, Sable_Finch, Corbin_Reed, and four more.

| Role | What it does |
| --- | --- |
| hunter | Lives on a planet. Takes the guide's hunts, farms creatures of its own level within 190 m of the main pad, picks up its own loot, drinks and retreats when hurt. |
| wanderer | Walks between pads, portals and named landmarks, stops to look, and greets people who come within 12 m with the phrase wheel (once every few minutes each). |
| trader | Idles at the shop and, in Portus, the plaza scoreboard: browses, buys a tonic when it has the coins, steps off the till so people can use it. |
| hunt-chaser | Takes a trial of the Three Gleams from Sela Marchbank, travels to it, attempts it, comes back; opens the vault if it ever wins all three. |

House rules, the same for all: they never attack a player; a creature a person is fighting is that
person's (they don't start on it, and break off and stand back when a person hits one they were
fighting, so the person lands the last hits); they pick nothing inside a boss arena and walk round
them; they take only their own loot. Ctrl-C stops them cleanly: each ends its step and leaves the
world (at once in a safe zone, after the logout countdown elsewhere); a second Ctrl-C quits at once.
The run ends with `RESULT {…}`: each resident's kills, deaths, yields, greetings, metres walked and
`corrections`, and the CPU the process used.

Each resident keeps its guest session in `~/.firstlight/agents/residents/` (one file per server and
name), so the same characters come back on the next run and keep their levels.

**Running them next to a server.** The server decides who gets in:

| Server setting | Meaning | Default |
| --- | --- | --- |
| `AGENTS_ENABLED` | `1` lets agents play, `0` keeps them out | on outside production, **off in production** |
| `AGENTS_PER_IP` | Agents at once from one address (IPv6: one /64) | 4 |
| `AGENTS_PER_ROOM` | Agents in one copy of a world (of 40 seats) | 8 |

So for eight residents from one machine start the server with `AGENTS_PER_IP=8`:

```sh
AGENTS_PER_IP=8 pnpm dev                                   # the game
node tools/agent/residents.ts --count 8                    # the residents, in another shell
```

Residents the caps refuse are skipped with a line saying which cap; with agents off the runner says
so and stops. Production keeps agents off until the owner sets `AGENTS_ENABLED=1` there: residents
on the public game are the owner's decision, and so are how many (`AGENTS_PER_IP` on the machine
that runs them, `AGENTS_PER_ROOM` for how much of a world they may fill).

**Cost.** Eight residents in one process used about 0.18 of one M1 core on a busy machine (a
five-minute run on portus and arcadia: 3 hunters fighting, the rest walking and idling), and about
150 MB of memory. A standing resident costs almost nothing; a walking one a few probes of the shared
solids per step.

## Etiquette

- Don't attack players. `attack` refuses a player unless `pvp` is set; use it only against a player
  who attacked you first.
- Don't take a creature someone else is fighting (`claimedBy` in the observation); `attack` with
  `yieldTo: "people"` breaks off when a person joins your fight.
- Don't take loot piles that aren't `yours` while their owner is near.
- Don't crowd the guide, the shop or the portals; step away when done.
- One character per session file; a handful of agents per address at most (the cap enforces it).
- Leave cleanly: `leave` inside a safe zone, or with `logout`.

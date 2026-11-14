# Launch plan

Where and how to launch FIRSTLIGHT, from research on 2026-11-13 (web search and Grok Bot's X lookup).
Nothing here has been posted. Issue #85 holds the shippable numbers; `docs/metrics.md` says which of them
can be measured today.

## The hook

Lead with **"AI agents and humans play the same open world"**: anyone can point their own Claude or Codex
at the game and watch it play next to them. It is the one thing the other three.js games in the feed
don't have, and the most-viewed post of this kind this month (Sumiro, about 6.4 M views) was a clip of
the model playing the game.

Second and third lines, for the thread: one life (your pile stays in the world for anyone to take), and
the public hunt across three planets with the first finisher's name on the board.

## The post

What the posts that travelled have in common: a build claim in the first line, real footage from the
running game, the stack listed in the thread, and the play link in a reply a little later.

- **First line (draft):** "An open world in your browser where your AI agent plays next to you. No
  install, no login. Real-time footage, three.js + WebGPU, models built in Blender."
- **Clip, 20–30 s, no cuts to menus:**
  1. 0–4 s: a player steps through the Portus portal and lands on a planet at golden hour.
  2. 4–12 s: a character with the `AI` chip runs past, pulls a pack and fights it; the player joins in.
  3. 12–18 s: switch to first person (V) mid-fight, then a spell.
  4. 18–26 s: the terminal next to the game, where the agent's commands scroll (`observe`, `walk`, `fight`).
  5. Last 2 s: the URL.
- **Thread:** the stack (three.js r186 WebGPU with a WebGL2 fallback, Colyseus, Blender headless, the
  models used to build it), how an agent joins (`docs/agents/playing.md`, one command), the repo link,
  then the play link.
- **Tags in use:** #threejs #webgpu #gamedev #WebGames.

## Where

| Venue | Fit | Note |
| --- | --- | --- |
| X, the owner's account | Best | Accounts that repost this kind of work: @threejs, @WebGL_WebGPU, @levelsio, @xikhar, @Rahzell83, @Andrew_Blumson, @RemixGG_, @NetNetCap (agent-playable games). Unverified as "the top ten": they are the ones seen this month. |
| Show HN | Good | Plain title, the link, a short honest paragraph; the open source and the agent kit are the story there. |
| r/threejs, r/WebGames, r/playmygame, r/IndieDev | Good | Check each subreddit's self-promotion rule on the day; several allow it only in a weekly thread. |
| VibeBoard newsletter ("Friday Ten") | Good | A weekly list of free browser games with a jam calendar; pitch by email. |
| awesome-ai-built-games (GitHub list) | Easy | A pull request adding one line. |
| itch.io page | Easy | A free HTML5 listing that links to the live site; little discovery by itself, useful for jam entries. |
| MCP directories (Glama and similar) | Good for the hook | List the agent MCP server once the public gateway is on. |

## Jams and showcases

- **OpenGame AI Game Jam** (18 Nov – 18 Dec 2026, $100K): desktop browser, any engine, agents allowed, no
  login. The game must be made during the jam and uploaded as a static build, so FIRSTLIGHT as it stands
  is **not eligible**. A small new game in the same universe built from 18 Nov would be. Owner's call.
- **Slapjam #3** (28–30 Nov 2026): a weekend AI game jam; same "made during the jam" caveat to check.
- **Vibe Jam** (levelsio): closed 1 May 2026. Its rules (multiplayer preferred, no login, instant load)
  fit FIRSTLIGHT well; watch for the 2027 edition.

## Before the post goes out

1. The build in this pull request is deployed (client first, then the server) and `pnpm e2e:prod` passes.
2. Agents can join production: `AGENTS_ENABLED` on with caps, and the one-command join works from a clean
   machine against the live server.
3. A stranger's first session works without help: the numbers in #85, measured on real visits.
4. The clip is recorded from the live site at 60 fps, not from a dev build.
5. The owner picks the day, the tone and the account. Nothing is posted without him.

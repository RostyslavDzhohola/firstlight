# Metrics: everything we can measure, and the one command that measures it

The catalogue a hill climb points at (owner, 2026-11-13: "catalog anything that can be measured … in
order"). Every number has an id, a unit, a better direction, one command that prints it, its run-to-run
noise (measured: three runs) and whether a hill climb can use it as is. Groups are ordered from cheapest
to most expensive to measure.

## Running it

```sh
pnpm metrics                      # static + health (~1 min): build, bundle, typecheck, balance
pnpm metrics --load               # + first visit in a headless browser, cold and warm (~1 min)
pnpm metrics --server             # + the server under 1/25/50/80 bots (~3 min)
pnpm metrics --frame              # + ?bench on all four bodies at Medium (~3 min)
pnpm metrics --tests              # + Vitest count and time per project (~4 min)
pnpm metrics --passes             # + ?bench=passes per-pass GPU ms at High (~20 min, WebGPU)
pnpm metrics --all                # everything
pnpm metrics --only frame --bodies portus --tier high --gfx webgpu,webgl --seconds 30
pnpm metrics --repeat 3           # each group 3×: medians, and noise raised to the observed spread
pnpm metrics --compare before.json after.json   # deltas; exit 1 when anything got worse beyond noise
pnpm metrics --merge a.json b.json --out all.json
```

Each run writes `tools/bench/results/metrics-<time>-<commit>.json` (gitignored). The browser groups
use the journeys' stack (`apps/client/e2e/metrics.spec.ts`, headless and muted, ports `E2E_PORT` /
`E2E_CLIENT_PORT`, default 2612/5212); the server group starts its own server on
`METRICS_SERVER_PORT` (default 2622) with fresh databases and a throwaway load-test secret.

### The run file (schema v1, `tools/metrics/schema.ts`)

```jsonc
{ "v": 1, "when": "…", "commit": "…", "branch": "…", "dirty": false,
  "machine": { "os", "cpu", "cores", "memGB", "node", "busy", "load1" },
  "groups": ["static", "health"], "repeat": 3, "notes": [],
  "metrics": [ { "id": "frame.webgpu.medium.portus.gpu_busy.p50", "value": 7.36, "unit": "ms",
                 "better": "lower", "group": "frame", "noise": 0.1, "floor": 0.25 } ] }
```

- `noise` is the typical run-to-run spread as a fraction of the value (0.1 = ±10 %); 0 means
  deterministic. The noise in the tables below was measured with three runs (the server two) on a
  machine at load 60–350, so treat it as an upper bound. An idle machine's spread is smaller. `floor` (optional) is an absolute spread for counts that sit near zero.
- `--compare` calls a change real when it moves past `max(noise × |before|, floor)`, using the larger
  noise of the two runs. Anything else is "same".
- `machine.busy` is true when the 1-minute load average is over half the cores. Frame, load and server
  numbers from a busy machine are relative at best: compare only runs taken in the same few minutes.

### Hill-climb notes

- **Frame time is capped by vsync.** Headless Chrome on the M1 presents at 60 Hz, so `fps`,
  `frame.p50` and `frame.p95` sit at 60 / 16.7 ms whenever the frame fits. Climb `gpu_busy.p50`
  (GPU work per frame) and `cpu.p50` (main-thread work per frame) instead. They move when the
  work changes, and `frame.*` only once the work stops fitting in the frame.
- **Draw calls, triangles, GPU memory and resource counts are close to deterministic** for a given
  body, tier and camera path (±2 %). They are the cheapest frame metrics to climb, and a change in them
  is real.
- **Bytes are exact.** Every `static` metric is deterministic for a given source tree: any change is real.
- Use `--repeat 3` before and after any change whose metrics have a noise over 10 %.

## 1. Health (≈2 s): `pnpm metrics --only health`

| id | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `balance.checks.failed` | balance-model band checks out of band (`tools/balance`) | checks | lower | exact | yes (gate: must stay 0) |
| `balance.checks.total` | band checks the model runs | checks | higher | exact | no (coverage) |

## 2. Static and build (≈1 min): `pnpm metrics` (default)

From a production client build (`apps/client/dist`), analysed by `tools/metrics/bundle.ts`. Gzip is
level 9, brotli quality 11 (what a CDN serves at best).

| id | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `build.client.ms` | `pnpm --filter @firstlight/client build` wall time | ms | lower | ±75 % | yes, with `--repeat 3` |
| `typecheck.ms` | `pnpm typecheck` wall time (shared, server, client in parallel) | ms | lower | ±136 % | yes, with `--repeat 3` |
| `typecheck.errors` | TypeScript errors | errors | lower | exact | gate |
| `bundle.js.count` | JS files in the build | files | lower | exact | yes |
| `bundle.js.{raw,gzip,br}` | all JS, summed | KB | lower | exact | yes |
| `bundle.css.{raw,br}` | all CSS, summed | KB | lower | exact | yes |
| `chunk.<name>.{raw,gzip,br}` | each JS/CSS chunk of 20 KB or more, named without its hash (`chunk.game.js.br`, `chunk.three.tsl.js.br`) | KB | lower | exact | yes |
| `dist.<kind>.{bytes,files}` | every file of the build by kind: js, css, image, model, font, data, other | KB, files | lower | exact | yes |
| `dist.total.bytes` | the whole build (what a deploy uploads) | KB | lower | exact | yes |
| `firstvisit.home.{requests,raw,br}` | index.html, its module scripts and their static imports, its CSS: what must arrive before the home page runs | requests, KB | lower | exact | yes |
| `firstvisit.world.{requests,raw,br}` | the above plus the Game chunk's static closure and its CSS: code the world needs before its first frame | requests, KB | lower | exact | yes |

Not in the static group, because the build doesn't hold them: the large art (planet GLBs, HD art
packs) served by the asset Worker. `load.*.world.transfer` counts them as a browser fetches them.

## 3. Load (≈1 min per backend): `pnpm metrics --load [--gfx webgpu,webgl] [--tier medium]`

A fresh headless browser (cold HTTP cache) opens `/?e2e`, waits for the home menu, presses Play,
picks a starter and waits until the world runs (`e2e/metrics.spec.ts`). It then visits again in the
same browser (`warm`: HTTP cache, Chrome's GPU program cache and the saved guest all warm). Times
are page milliseconds from navigation start. Ids are `load.<gfx>.<cold|warm>.…`.

| id suffix | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `fcp.ms` | first contentful paint | ms | lower | ±25 % | yes, `--repeat 3` |
| `menu.ms` | navigation → the Play button visible (the menu) | ms | lower | ±25 % | yes, `--repeat 3` |
| `play_to_world.ms` | Play pressed → in the world (issue #85 "gets in: median under 30 s") | ms | lower | ±20 % | yes, `--repeat 3` |
| `nav_to_world.ms` | navigation → in the world | ms | lower | ±20 % | yes, `--repeat 3` |
| `menu.{requests,transfer}` | requests and bytes over the wire (Resource Timing) up to the menu | requests, KB | lower | ±2 % | yes |
| `world.{requests,transfer,decoded}` | the same up to the world; `decoded` is after decompression | requests, KB | lower | ±2 % | yes |
| `warmup.ms` | the arrival's shader warm-up (render/warmup.ts) | ms | lower | ±25 % | yes, `--repeat 3` |
| `warmup.builds` | node material builds during the warm-up | builds | lower | ±2 % | yes |
| `warmup.stages` | new GPU shader stages compiled (pipelines) | programs | lower | ±2 % | yes |
| `warmup.gap_max.ms` | the longest gap between animation frames during the warm-up (what a freeze looks like) | ms | lower | ±40 % | with care |
| `warmup.gaps_over250` | frame gaps over 250 ms during the warm-up | gaps | lower | floor 2 | gate |
| `warmup.longtasks` | main-thread tasks over 50 ms during the warm-up | tasks | lower | ±30 % | with care |
| `shaders_after_warmup` | shader builds in the 120 frames after the warm-up (a hitch while playing) | builds | lower | exact | gate: must stay 0 |
| `heap` | JS heap in the world | MB | lower | ±10 % | with care |

## 4. Server (≈3 min): `pnpm metrics --server [--bots 1,25,50,80] [--server-seconds 20]`

The real server (`apps/server/src/main.ts`) with fresh databases; for each level, N load-test bots
(`tools/bots/src/load.ts --dev`) join Portus, run round the pad at 20 Hz inputs, and the collector reads
`/api/metrics` twice over the steady part. Ids are `server.bots<N>.…`. 80 is the most one body takes:
rooms hold 40 (`NET.MAX_CLIENTS`) and load tests may open 2 copies of a body (`BOT_BUDGET.copiesPerBody`).
At 100, the last 20 bots retry their refused joins for about 19 minutes. The collector kills a level
whose bots haven't finished after its run time plus 3 minutes, and reports how many joined.

| id | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `server.idle.{rss,heap}` | the process with no rooms | MB | lower | ±15 % | with care |
| `…joined`, `…rooms` | bots that got in, rooms they filled | bots, rooms | higher / lower | exact | gate |
| `…tick.p50/p95/p99` | `BodyRoom.tick` duration over the last 400 ticks (the room's 20 Hz simulation) | ms | lower | ±25–77 % | yes at 50+ bots, `--repeat 3` |
| `…cpu` | server process CPU over the sampled window | % of a core | lower | ±15 % | yes, `--repeat 3` |
| `…rss`, `…heap` | process memory at that load | MB | lower | ±10–20 % | with care |
| `…rx_per_client` | bytes each client receives per second | KB/s | lower | ±10–22 % | yes |
| `…msgs_per_client` | messages (state patches and events) per client per second | msg/s | lower | ±5–18 % | yes |
| `…patch_bytes` | mean message size | B/msg | lower | ±10 % | yes |
| `…join.p50/p95` | one bot's `/api/play` → its player replicated in room state | ms | lower | ±30–72 % | with care |
| `…npcs` | NPCs alive in the room | npcs | higher | ±5 % | no (content) |
| `server.rss_per_player`, `server.heap_per_player` | memory slope between the smallest and largest load | MB | lower | ±30–39 % | with care |
| `server.heap_per_room` | one bot's room over the idle heap | MB | lower | ±47 % | with care |

Bandwidth per player-hour is `rx_per_client × 3.6` MB (the bots' RESULT line also prints it).

## 5. Frame (≈1 min per body): `pnpm metrics --frame [--tier medium] [--bodies …] [--gfx …] [--seconds 20]`

`?bench&offline&autoplay` (render/bench.ts) on each body at a fixed tier: 8 s warm-up on the scripted
camera path (ground loop, rising orbit, low figure-eight round the spawn), then the recorded run.
Ids are `frame.<gfx>.<tier>.<body>.…`.

| id suffix | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `gpu_busy.p50/p95` | GPU busy time per frame (WebGPU pass union) | ms | lower | ±10–32 % | **yes: the main frame metric** |
| `cpu.p50/p95` | main-thread time per frame (game update + render submission) | ms | lower | ±15–25 % | **yes** |
| `fps`, `frame.p50/p95/p99/max` | frame interval (vsync-capped at 60 Hz: see the note above) | fps, ms | higher / lower | ±5–280 % | only once frames stop fitting |
| `over33`, `over50`, `over100` | frames over 33, 50 and 100 ms in the run | frames | lower | floor 1–3 | gate |
| `draws` | draw calls per frame, mean | calls | lower | ±2 % | **yes** |
| `triangles` | triangles per frame, mean | ktris | lower | ±2 % | **yes** |
| `shader_builds` | shader builds during the run | builds | lower | exact | gate: must stay 0 |
| `gpu_mem.total`, `gpu_mem.textures` | three's estimate of GPU memory (renderer.info.memory) | MB | lower | ±2 % | yes |
| `geometries`, `textures`, `programs` | live GPU resources | count | lower | ±2 % | yes |
| `heap.end`, `heap.growth` | JS heap at the end, and its growth over the run (a leak or per-frame allocation) | MB | lower | ±10–50 % | with care |

Per pass: `pnpm metrics --passes [--tier high]` runs `?bench=passes` (bench-passes.spec.ts): the fixed
view rendered in uncapped batches with each feature off in turn. `passes.<tier>.<feature>` is that
feature's cost in ms per frame (floor 0.25 ms), `passes.<tier>.baseline.p50` the whole frame,
`passes.<tier>.noise_floor` the run's own noise, `passes.<tier>.gtao.s<samples>_x<scale>` the GTAO sweep. Run it only on a quiet
machine (#52: a busy machine's noise floor reached 2.6 ms).

## 6. Tests (≈4 min): `pnpm metrics --tests [--projects shared,client,server]`

| id | meaning | unit | better | noise | climb? |
|---|---|---|---|---|---|
| `tests.<project>.count` | Vitest tests in the project | tests | higher | exact | no (coverage) |
| `tests.<project>.failed` | failing tests | tests | lower | floor 1 (load-sensitive timeouts) | gate |
| `tests.<project>.ms` | wall time of `pnpm vitest run --project <p>` | ms | lower | not measured tonight | yes, `--repeat 3` |

## 7. Not yet collected (measurable with what exists, not wired)

| what | how it could be measured | why not tonight |
|---|---|---|
| Per-body numbers on WebGL2 | `--gfx webgl` works today | doubles the run; WebGPU is the default backend |
| High and Ultra frame numbers | `--tier high` works today | the baseline is the default tier (Medium) |
| Frame time in the owner's real window size (#87) | `?bench` with a larger viewport (`E2E_VIEWPORT` is not a knob yet) | see the #87 section |
| Client-measured ping and server tick jitter | the perf overlay shows ping; `__fl` could expose it | needs a hook field |
| Mobile / touch numbers | jpad-touch.spec emulation | no device in the loop |
| GPU memory from the browser | `GPUAdapterInfo` has no budget API | three's estimate stands in |

## 8. Game health and the launch KPIs (issue #85)

Issue #85 proposes ship-readiness KPIs. Which ones can be measured today, from what, and what is missing:

| KPI (#85) | measurable today? | from | missing |
|---|---|---|---|
| **Gets in:** 80 % of visitors who press Play reach the world | **no** | — | the server never logs a Play press or a failed join. Needed: a `play_attempt` row from `/api/play` (or a client beacon) joined with `session_log` |
| **Gets in:** median under 30 s from Play | **in the lab: yes**; real visits: no | `load.<gfx>.cold.play_to_world.ms` (headless, this machine) | a client beacon of Play → in-world ms per real session (the hook already knows both times) |
| **Understands it:** 60 % finish the tutorial | **no** | the tutorial step lives in the client (`onboardingProgress`) | a server-side record of the step reached (the client could send it with the session end) |
| **Understands it:** 40 % take a mission | **partly** | `character.mission_state_json` holds accepted missions per character | an aggregate query on `/stats` (characters reset on death, so count at session end) |
| **Has fun:** median first session over 10 min | **partly** | `session_log` (`started_at`, `ended_at`): `/stats` shows the median session, not the first one | a first-session filter (`MIN(started_at)` per user), one SQL query |
| **Has fun:** 25 % reach level 5 | **yes** | `session_log.max_level`: `/stats` "Highest level per session" | per player rather than per session (one query) |
| **Comes back:** 15 % return within a week | **yes** | `session_log` → `/stats` D1/D7 return by cohort | "within a week" (any day 1–7) instead of exactly day 7 |
| **Comes back:** 30 % of level-2 players save | **no** | saved accounts are in Better Auth's database, guests in `account` | a join of auth users (email present) with `session_log.max_level ≥ 2` |
| **Runs:** 60 fps on a 2020 laptop, default tier | **in the lab: yes**, on this M1 only | `frame.<gfx>.medium.<body>.fps` / `gpu_busy` | the real-visit perf beacon; `session_log` stores backend and tier but not frame time |
| **Runs:** never under 30 fps | **in the lab: yes** | `frame.….over33` | the same beacon (count of frames over 33 ms per session) |
| **Runs:** no crash or soft-lock in 50 sessions | **partly** | server errors only (`/admin`'s ring buffer, `apps/server/src/ops/errors.ts`); the journeys catch soft-locks in the lab | client error reports, a per-session "ended normally" flag, and a 50-session bot or play-test sample |

The cheapest missing piece is one client beacon at session end, carrying the Play → world ms, the
tutorial step reached, frames over 33 ms and the mean fps. With it, eight of the eleven rows become
real-visit numbers.

## Baseline (2026-11-13, `night/integration` head)

The full baseline is `docs/metrics/baseline-2026-11-13.json` (219 metrics, commit `f9fd7ff0`, which is
`night/integration` 7afbca81's game code plus the collector). Static, frame and health ran 3 times, the server twice.
Compare a later run with `pnpm metrics --compare docs/metrics/baseline-2026-11-13.json <new.json>`.

**Every frame, load and server number below was taken on a very busy machine** (load average 60–350
on 8 cores while four lanes built, tested and ran Blender). Read them as relative, and re-run them on an
idle machine before you climb against them. Bytes, counts, draw calls, triangles and GPU memory are
unaffected.

Static and build:

| metric | value |
|---|---:|
| `bundle.js.br`: all JS, brotli | 763 KB |
| `chunk.three.tsl.js.br` / `chunk.game.js.br` | 209 / 221 KB |
| `firstvisit.home.br`: before the home page runs | 25 KB (3 requests) |
| `firstvisit.world.br`: code before the world's first frame | 645 KB (29 requests) |
| `dist.total.bytes` (of which models 8.0 MB, images 6.1 MB) | 17.7 MB |
| `build.client.ms` / `typecheck.ms` (busy machine: ±75 % / ±136 %) | 3.2 s / 4.4 s |
| `balance.checks.failed` | 0 of 650 |

Frame (`?bench`, WebGPU, Medium, 1280×720, DPR 1, 20 s per body):

| metric | Portus | Arcadia | Hollowmere | Meridian |
|---|---:|---:|---:|---:|
| `gpu_busy.p50` (ms) | 4.21 | 3.67 | 3.93 | 3.23 |
| `cpu.p50` (ms) | 3.6 | 5.8 | 6.4 | 5.0 |
| `fps` (vsync 60) | 59.6 | 60.0 | 59.1 | 60.0 |
| `frame.p99` (ms) | 19.9 | 18.5 | 25.4 | 18.5 |
| `over33` (frames in 20 s) | 2 | 0 | 5 | 0 |
| `draws` | 81 | 131 | 159 | 120 |
| `triangles` (k) | 504 | 371 | 432 | 203 |
| `gpu_mem.total` (MB, three's estimate) | 236 | 263 | 266 | 198 |
| `programs` | 140 | 159 | 163 | 156 |
| `heap.growth` (MB over 20 s) | 23 | 30 | 32 | 24 |

`heap.growth` says the game allocates about 1.2–1.6 MB of JS objects a second while you look round:
garbage-collection pauses waiting to happen, and the first thing to climb on the CPU side.

Server (Portus, load-test bots, 20 s per level):

| metric | 1 bot | 25 bots | 50 bots (2 rooms) |
|---|---:|---:|---:|
| `tick.p50` (ms) | 0.94 | 0.97 | 1.6 |
| `tick.p95` (ms) | 18 | 11 | 38 |
| `tick.p99` (ms) | 73 | 36 | 85 |
| `cpu` (% of a core) | 4 | 11 | 13 |
| `rx_per_client` (KB/s) | 2.1 | 7.0 | 5.6 |
| `patch_bytes` (B per message) | 73 | 262 | 330 |
| `join.p50` (ms) | 1416 | 95 | 147 |

Per player the server holds about 0.7 MB of heap (`server.heap_per_player`); idle it is 102 MB RSS.
The tick p95/p99 here are the machine's scheduling, not the game: at load 100+ a 20 Hz timer wakes late.
A median tick of about 1 ms says the room's work is small. 50 bots fill two rooms (40 per room).

Load (`--load`, WebGPU, Medium, one cold visit at load ≈ 50; the later 3× runs timed out at load 460+):

| metric | value |
|---|---:|
| `fcp.ms`: first contentful paint | 324 ms |
| `menu.ms`: the Play button visible | 1.09 s (34 requests, 712 KB over the wire) |
| `play_to_world.ms`: Play → in the world (#85: "median under 30 s") | 5.7 s |
| `nav_to_world.ms` | 6.8 s |
| `world.requests` / `world.transfer` | 173 / 11.7 MB |
| `warmup.ms` / `warmup.stages` / `warmup.builds` | 2.26 s / 187 programs / 288 builds |
| `warmup.gap_max.ms` / `warmup.longtasks` | 149 ms / 3 |
| `shaders_after_warmup` | 0 |

The load noise in the catalogue (±20–25 % for times) is an estimate from two single runs, not a 3× measurement.

## Changes measured tonight (before → after, same collector)

### #74: tree cross-fade (D-metrics-2)

`pnpm metrics --only frame --bodies arcadia,hollowmere` on `f9fd7ff0` (before) and the lane head
(after), taken one after the other (load 527 and 576):

| metric | Arcadia before → after | Hollowmere before → after |
|---|---:|---:|
| `draws` | 131 → 131 | 159 → 159 |
| `triangles` (k) | 371 → 371 (+0.1 %) | 433 → 434 (+0.3 %) |
| `programs` | 159 → 159 | 163 → 163 |
| `shader_builds` during the run | 0 → 0 | 0 → 0 |
| `gpu_busy.p50` (ms) | 8.4 → 3.4 | 9.3 → 3.7 |
| `cpu.p50` (ms) | 7.3 → 6.1 | 7.2 → 5.7 |

No new draw call, pipeline or shader build. The only added work is the far cards inside the band
(+0.1–0.3 % triangles) and one dither test per fragment of a modelled prop. The GPU and CPU times
moved far more than any change could: that is the machine's load moving between the two runs.
Re-run both on a quiet machine to price the dither (expected: within noise).

### #87: slowdowns in a real Chrome window

What could be found without the owner, on this M1 (load ≈ 590, so relative only):

| window | canvas | `gpu_busy.p50` | `fps` | `frame.p95` | `over33` in 20 s |
|---|---:|---:|---:|---:|---:|
| 1280×720, DPR 1 (the bench default; baseline) | 1360×765 (1.04 Mpx) | 4.2 ms | 59.6 | 18.0 ms | 2 |
| 1920×1080, DPR 2 (a Retina window, full screen) | 2040×1147 (2.34 Mpx) | 17.0 ms | 43.3 | 31.8 ms | 23 |

- **Resolution.** Medium renders at `min(DPR, dprCap 1.25) × renderScale 0.85` = 1.06 of CSS pixels,
  so a full-screen Retina window draws 2.3× the pixels of the 720p bench. GPU time per frame rose
  about 4×, and the frame no longer fits in 16.7 ms.
- **The resolution ladder reacts late on the M1.** `?bench` turns the ladder off (`renderer.ts`), so
  the row above is Medium's fixed cost. In play the ladder steps down, but on the M1 the GPU timer is
  "untrusted" (`gpuPlausible` fails), so it steps down only when the 2 s median frame passes 20 ms
  (`timing.ts`). A window that runs at 40–55 fps with 30 ms spikes (median under 20 ms) is left at
  full resolution. That matches "some slowdowns", and it is the first thing to try: step down on the
  share of frames over 20 ms (`over33` is already measured), not only the median.
- **Shader builds after the warm-up: 0** in every load and frame run tonight
  (`load.*.shaders_after_warmup`, `frame.*.shader_builds`), so post-warm-up compiles are not the cause
  here, on WebGPU at Medium.
- Still needed from the owner: the overlay (backtick) during a stutter, the window size, the backend and the world.
  `pnpm metrics --frame --viewport <w>x<h> --dpr <n>` reproduces any window size headless.

### #66: GTAO's fixed cost on High/Ultra

`?bench=passes&benchgtao=denoise` (`pnpm metrics --passes --tier high --flags benchgtao=denoise`) now
prices where the denoise runs: inline per screen pixel (today), into a target at the AO's own
resolution (`AoDenoise "ao"` in `render/post.ts`), or not at all, at full, half and quarter
resolution. **Tonight's run is invalid.** At load 773 one frame took over 5 s, so only the
first round finished: `ao` 9.7 ms, `bloom` 4.9 ms, `grass` 2.4 ms of a 20.7 ms frame at High, with a 3.9 ms
noise floor. That ranking matches #52, but no variant got a number. The shipped path is unchanged
(`AO_DENOISE = "full"`). Next step on a quiet machine: run the sweep, pick the cheapest variant
whose stills match, and set `AO_DENOISE`.

### The three cheapest wins: found, not taken tonight

The brief asked for gains the collector can show with nothing getting worse. On a machine at load
200–770 the timing metrics couldn't show any gain, so none was taken. The candidates the baseline
points at, cheapest first:

1. **Per-frame JS garbage** (`frame.*.heap.growth`, 23–32 MB per 20 s run: about 1.2–1.6 MB/s).
   `pnpm metrics --frame --heapprof` writes the allocation sites of the recorded run into the raw
   report (`tools/bench/results/raw-frame-*.json`, `heapSites`). The first profile reported only
   surviving objects; the spec now asks Chrome for collected ones too. Run it once, then fix the top
   site or two in our code (gain: `heap.growth` towards 0, fewer GC pauses in `over33`).
2. **The resolution ladder on the M1** (#87 above): step down on the share of frames over 20 ms,
   not only the median. Gain: `over33` at large windows; it changes no bytes and draws nothing new.
3. **Fonts shipped twice**: `dist.font.files` 20 = 10 `.woff2` plus 10 legacy `.woff` that no
   supported browser fetches (`dist.font.bytes` 475 KB). Dropping the `.woff` halves deploy bytes for
   fonts. No player-facing gain, so it ranks last.

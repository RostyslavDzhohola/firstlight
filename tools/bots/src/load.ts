// Load-test bots (F2). Each bot joins a body through /api/play, wanders around the main pad at
// running speed sending 20 Hz inputs that pass server validation, optionally shoots, and counts
// the bytes it receives. Bots only ever join load-test rooms in production (never the public world).
//
// Usage:
//   node src/load.ts --url http://localhost:2567 --bots 40 --body arcadia --seconds 120 --dev
//   LOADTEST_SECRET=… node src/load.ts --url https://api.firstlight.one4all.dev --bots 40 --seconds 600

import { BODIES, createTerrain, padDirs, type BodyId } from "@firstlight/shared";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(a.slice(2), next);
      i++;
    } else args.set(a.slice(2), "1");
  }
}
const URL_ = args.get("url") ?? "http://localhost:2567";
const BOTS = Number(args.get("bots") ?? 10);
const BODY = (args.get("body") ?? "arcadia") as BodyId;
const SECONDS = Number(args.get("seconds") ?? 60);
const DEV = args.has("dev");
const FIRE = args.has("fire");
const SECRET = process.env.LOADTEST_SECRET ?? "";

// Count received bytes per bot by wrapping the global WebSocket before the SDK loads.
let rxBytes = 0;
const Base = globalThis.WebSocket;
class CountingWS extends Base {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as ArrayBuffer | Blob | string;
      rxBytes += typeof d === "string" ? d.length : d instanceof ArrayBuffer ? d.byteLength : (d as Blob).size;
    });
  }
}
(globalThis as { WebSocket: typeof WebSocket }).WebSocket = CountingWS as typeof WebSocket;
const { Client } = await import("@colyseus/sdk");

const body = BODIES[BODY];
const terrain = createTerrain(body);
const R = body.radius;
const pad = padDirs(body)[0]!;

async function token(i: number): Promise<string> {
  if (DEV) return `dev:bot${i}:Bot${i}:loadtest`;
  const r = await fetch(`${URL_}/api/test/bot-token`, { method: "POST", headers: { "x-loadtest-secret": SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ name: `Bot${i}` }) });
  if (!r.ok) throw new Error(`bot-token ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

function tangentBasis(up: number[]) {
  const ref = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0]! * up[0]! + ref[1]! * up[1]! + ref[2]! * up[2]!;
  const t = [ref[0]! - d * up[0]!, ref[1]! - d * up[1]!, ref[2]! - d * up[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const a = t.map((v) => v / tl);
  const b = [up[1]! * a[2]! - up[2]! * a[1]!, up[2]! * a[0]! - up[0]! * a[2]!, up[0]! * a[1]! - up[1]! * a[0]!];
  return { a, b };
}

interface Bot {
  i: number;
  room: any;
  pos: number[];
  heading: number;
  seq: number;
}

const bots: Bot[] = [];
const t0 = Date.now();
let joinFailures = 0;

async function spawnBot(i: number) {
  try {
    const tok = await token(i);
    const r = await fetch(`${URL_}/api/play`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ body: BODY, loadtest: true }) });
    const res = (await r.json()) as { ok: boolean; reservation?: unknown };
    if (!res.ok) throw new Error(JSON.stringify(res));
    const client = new Client(URL_);
    const room = await client.consumeSeatReservation(res.reservation as never);
    for (const t of ["you", "hit", "shot", "projectile", "explode", "death", "toast", "swing", "phrase", "correct", "denied", "pong", "reborn", "announce", "boss", "broke", "rebuilt", "loggedOut", "updating"]) room.onMessage(t, () => {});
    const bot: Bot = { i, room, pos: [], heading: Math.random() * Math.PI * 2, seq: 0 };
    await new Promise<void>((ok) => {
      const check = () => {
        const me = (room.state as any).players?.get(room.sessionId);
        if (me) {
          bot.pos = [me.x, me.y, me.z];
          ok();
        } else setTimeout(check, 50);
      };
      check();
    });
    room.onMessage("correct", (m: { x: number; y: number; z: number }) => (bot.pos = [m.x, m.y, m.z]));
    bots.push(bot);
  } catch (e) {
    joinFailures++;
    console.error(`bot ${i} failed to join:`, (e as Error).message);
  }
}

for (let i = 0; i < BOTS; i++) {
  await spawnBot(i);
  await new Promise((r) => setTimeout(r, 40));
}
console.log(`${bots.length}/${BOTS} bots joined ${BODY} in ${((Date.now() - t0) / 1000).toFixed(1)} s (${joinFailures} failures)`);

const SPEED = 6;
const DT = 0.05;
let ticks = 0;
const startRx = rxBytes;
const tStart = Date.now();
const iv = setInterval(() => {
  ticks++;
  for (const b of bots) {
    const up = b.pos.map((v) => v / Math.hypot(...(b.pos as [number, number, number])));
    // Wander, but steer back towards a 70 m ring around the main pad.
    const toPad = [pad[0] - up[0]!, pad[1] - up[1]!, pad[2] - up[2]!];
    const distPad = Math.hypot(toPad[0]!, toPad[1]!, toPad[2]!) * R;
    b.heading += (Math.random() - 0.5) * 0.3;
    const { a, b: bb } = tangentBasis(up);
    let dir = [a[0]! * Math.cos(b.heading) + bb[0]! * Math.sin(b.heading), a[1]! * Math.cos(b.heading) + bb[1]! * Math.sin(b.heading), a[2]! * Math.cos(b.heading) + bb[2]! * Math.sin(b.heading)];
    if (distPad > 70) {
      const k = toPad[0]! * up[0]! + toPad[1]! * up[1]! + toPad[2]! * up[2]!;
      const tp = [toPad[0]! - k * up[0]!, toPad[1]! - k * up[1]!, toPad[2]! - k * up[2]!];
      const l = Math.hypot(tp[0]!, tp[1]!, tp[2]!) || 1;
      dir = tp.map((v) => v / l);
    }
    const np = [b.pos[0]! + dir[0]! * SPEED * DT, b.pos[1]! + dir[1]! * SPEED * DT, b.pos[2]! + dir[2]! * SPEED * DT];
    const nl = Math.hypot(np[0]!, np[1]!, np[2]!);
    const nd = np.map((v) => v / nl);
    const g = terrain.groundHeight(nd[0]!, nd[1]!, nd[2]!);
    const r = R + Math.max(g, body.waterLevel - 1.05);
    b.pos = nd.map((v) => v * r);
    b.room.send("input", { seq: ++b.seq, x: b.pos[0], y: b.pos[1], z: b.pos[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 2, t: Date.now() });
    if (FIRE && ticks % 20 === b.i % 20) {
      const o = b.pos.map((v, k) => v + up[k]! * 1.6);
      b.room.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: dir[0], dy: dir[1], dz: dir[2], t: Date.now() });
    }
  }
}, DT * 1000);

const report = setInterval(() => {
  const secs = (Date.now() - tStart) / 1000;
  const perBot = (rxBytes - startRx) / Math.max(1, bots.length) / secs;
  console.log(`t=${secs.toFixed(0)}s bots=${bots.filter((b) => b.room.connection?.isOpen !== false).length} rx/bot=${(perBot / 1024).toFixed(1)} KB/s total rx=${((rxBytes - startRx) / 1048576).toFixed(1)} MB`);
}, 10_000);

setTimeout(async () => {
  clearInterval(iv);
  clearInterval(report);
  const secs = (Date.now() - tStart) / 1000;
  const perBot = (rxBytes - startRx) / Math.max(1, bots.length) / secs;
  const result = { bots: bots.length, failures: joinFailures, seconds: Math.round(secs), rxPerBotKBs: +(perBot / 1024).toFixed(2), gbPerPlayerHour: +((perBot * 3600) / 1e9).toFixed(3) };
  console.log("RESULT", JSON.stringify(result));
  for (const b of bots) await b.room.leave().catch(() => {});
  process.exit(0);
}, SECONDS * 1000);

// One room = one copy of one body (Portus, Arcadia, Hollowmere or Meridian).
// Players enter only through POST /api/play (seat reservations); direct joins are refused.

import { Room, ServerError, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { BODIES, createTerrain, isSafe, padDirs, type BodyDef, type BodyId, type Terrain } from "@firstlight/shared";
import { ANIM, BodyState, PF, PlayerState } from "@firstlight/shared/net/schema";
import { NET } from "@firstlight/shared/net/protocol";
import { z } from "zod";
import type { Identity } from "../auth/identity.ts";

export interface BodyRoomOptions {
  body: BodyId;
  copy: number;
  loadtest?: boolean;
}

export interface BodyRoomMetadata {
  body: BodyId;
  copy: number;
  loadtest: boolean;
}

/** Movement limits used by the server-side validator (SPEC §5.3, D3). */
export const MOVE = {
  maxSpeed: 9, // sprint
  dodgeBurst: 4.5, // extra metres a dodge can add within a tick window
  slack: 1.0, // metres of tolerance per check
  groundTolerance: 0.5,
  maxAboveGround: 40,
};

const inputSchema = z.object({
  seq: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  fx: z.number().min(-1).max(1),
  fy: z.number().min(-1).max(1),
  fz: z.number().min(-1).max(1),
  anim: z.number().int().min(0).max(31),
  t: z.number().finite(),
});

const pingSchema = z.object({ t: z.number().finite() });

interface PlayerRuntime {
  identity: Identity;
  lastX: number;
  lastY: number;
  lastZ: number;
  lastMoveAt: number;
  joinedAt: number;
  violations: number;
}

type ClientT = Client;

export class BodyRoom extends Room<{ state: BodyState; metadata: BodyRoomMetadata }> {
  maxClients = NET.MAX_CLIENTS;
  patchRate = NET.TICK_MS;
  maxMessagesPerSecond = 60;
  autoDispose = true;
  state = new BodyState();

  bodyDef!: BodyDef;
  terrain!: Terrain;
  runtime = new Map<string, PlayerRuntime>();

  // Seat reservations skip onAuth; anything else trying to join directly is refused.
  static async onAuth(): Promise<unknown> {
    throw new ServerError(403, "join through /api/play");
  }

  onCreate(options: BodyRoomOptions) {
    this.bodyDef = BODIES[options.body];
    this.terrain = createTerrain(this.bodyDef);
    this.state.body = options.body;
    this.state.copy = options.copy;
    void this.setMetadata({ body: options.body, copy: options.copy, loadtest: !!options.loadtest });

    this.onMessage("input", inputSchema, (client, msg) => this.handleInput(client, msg));
    this.onMessage("ping", pingSchema, (client, msg) => client.send("pong", { t: msg.t, serverTime: Date.now() }));

    this.setTimestep((dt) => this.tick(dt), NET.TICK_MS);
  }

  onJoin(client: ClientT, _options: unknown, auth?: Identity) {
    if (!auth) throw new ServerError(403, "no identity");
    const p = new PlayerState();
    const spawn = this.spawnPoint(client.sessionId);
    p.x = spawn[0];
    p.y = spawn[1];
    p.z = spawn[2];
    const up = norm(spawn);
    const f = tangentForward(up);
    p.fx = f[0];
    p.fy = f[1];
    p.fz = f[2];
    p.anim = ANIM.IDLE;
    p.maxHp = 100;
    p.hp = 100;
    p.level = 1;
    p.name = auth.name;
    p.userId = auth.userId;
    p.flags = (auth.admin ? PF.ADMIN : 0) | (auth.loadtest ? PF.LOADTEST : 0);
    this.state.players.set(client.sessionId, p);
    this.runtime.set(client.sessionId, {
      identity: auth,
      lastX: p.x,
      lastY: p.y,
      lastZ: p.z,
      lastMoveAt: Date.now(),
      joinedAt: Date.now(),
      violations: 0,
    });
    client.view = new StateView();
  }

  onDrop(client: ClientT) {
    this.allowReconnection(client, NET.RECONNECT_WINDOW_S);
  }

  onLeave(client: ClientT) {
    this.state.players.delete(client.sessionId);
    this.runtime.delete(client.sessionId);
    client.view?.dispose();
  }

  /** Spawn on the main pad (Portus: plaza), spread a little so players don't stack. */
  spawnPoint(seed: string): [number, number, number] {
    const pads = padDirs(this.bodyDef);
    const d = pads[0]!;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const a = ((h % 360) / 360) * Math.PI * 2;
    const r = 2 + (h % 5);
    const t1 = tangentForward(d);
    const t2 = cross(d, t1);
    const R = this.bodyDef.radius;
    const dir = norm([
      d[0] + ((Math.cos(a) * t1[0] + Math.sin(a) * t2[0]) * r) / R,
      d[1] + ((Math.cos(a) * t1[1] + Math.sin(a) * t2[1]) * r) / R,
      d[2] + ((Math.cos(a) * t1[2] + Math.sin(a) * t2[2]) * r) / R,
    ]);
    const g = this.terrain.groundHeight(dir[0], dir[1], dir[2]);
    return [dir[0] * (R + g + 0.05), dir[1] * (R + g + 0.05), dir[2] * (R + g + 0.05)];
  }

  handleInput(client: ClientT, msg: z.infer<typeof inputSchema>) {
    const p = this.state.players.get(client.sessionId);
    const rt = this.runtime.get(client.sessionId);
    if (!p || !rt || msg.seq <= p.seq) return;
    const now = Date.now();
    const dt = Math.max(0.05, (now - rt.lastMoveAt) / 1000);
    const dx = msg.x - rt.lastX, dy = msg.y - rt.lastY, dz = msg.z - rt.lastZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const allowed = MOVE.maxSpeed * dt * 1.25 + MOVE.dodgeBurst + MOVE.slack;
    const R = this.bodyDef.radius;
    const len = Math.sqrt(msg.x * msg.x + msg.y * msg.y + msg.z * msg.z);
    const ground = this.terrain.groundHeightAt(msg.x, msg.y, msg.z);
    const above = len - R - ground;
    let ok = dist <= allowed && above >= -MOVE.groundTolerance && above <= MOVE.maxAboveGround;
    if (!ok) {
      rt.violations++;
      // Correct the client: authoritative position stays where it was.
      client.send("correct", { x: rt.lastX, y: rt.lastY, z: rt.lastZ, seq: msg.seq });
      p.seq = msg.seq;
      return;
    }
    rt.lastX = msg.x;
    rt.lastY = msg.y;
    rt.lastZ = msg.z;
    rt.lastMoveAt = now;
    p.x = msg.x;
    p.y = msg.y;
    p.z = msg.z;
    p.fx = msg.fx;
    p.fy = msg.fy;
    p.fz = msg.fz;
    p.anim = msg.anim;
    p.seq = msg.seq;
  }

  tick(_dt: number) {
    this.state.time = Date.now();
    for (const [, p] of this.state.players) {
      const safe = isSafe(this.bodyDef, p.x, p.y, p.z);
      p.flags = safe ? p.flags | PF.SAFE : p.flags & ~PF.SAFE;
    }
  }
}

function norm(v: readonly number[]): [number, number, number] {
  const l = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/** A stable tangent direction at `up` (towards +Z projected, or +X near the poles of Z). */
export function tangentForward(up: readonly number[]): [number, number, number] {
  const ref = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0]! * up[0]! + ref[1]! * up[1]! + ref[2]! * up[2]!;
  return norm([ref[0]! - d * up[0]!, ref[1]! - d * up[1]!, ref[2]! - d * up[2]!]);
}

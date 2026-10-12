// Sky (seam 1): the real server driven by SDK bots. Two clients on the same copy get the same sky;
// slot changes are broadcast; an admin override reaches everyone on the copy.

import type { Room } from "@colyseus/sdk";
import { skyState, type SkyState } from "@firstlight/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Game } from "../src/app.ts";
import { SkySystem } from "../src/world/SkySystem.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
let run = 0;
const uid = (name: string) => `sky${name}${run}`;

beforeEach(async () => {
  run++;
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const inbox = new WeakMap<Room, SkyState[]>();

async function bot(name: string, role = ""): Promise<Room> {
  const r = await joinAs(game, uid(name), "arcadia", {}, role);
  rooms.push(r);
  const box: SkyState[] = [];
  inbox.set(r, box);
  r.onMessage("sky", (m: SkyState) => box.push(m));
  for (const t of ["you", "toast", "denied", "phrase", "correct", "pong", "hall", "social:blocked", "party:state", "kicked", "lamp", "prompt", "stage", "eggs", "npc:spawn"]) r.onMessage(t, () => {});
  r.onMessage("*", () => {});
  await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
  return r;
}

const skies = (r: Room) => inbox.get(r)!;

describe("sky (seam 1)", () => {
  it("gives two clients on the same copy the same sky", async () => {
    const a = await bot("a");
    const b = await bot("b");
    expect(a.roomId).toBe(b.roomId);
    a.send("skySync", {});
    b.send("skySync", {});
    await waitFor(() => skies(a).length > 0 && skies(b).length > 0);
    const sa = skies(a).at(-1)!;
    const sb = skies(b).at(-1)!;
    expect(sa.body).toBe("arcadia");
    expect(sb.copy).toBe(sa.copy);
    for (const k of ["weather", "intensity", "slotStart", "nextChangeAt", "nextWeather", "prevWeather", "override", "dayOffset"] as const) {
      expect(sb[k]).toEqual(sa[k]);
    }
    // Same clock: the day phases agree once extrapolated to the same instant.
    const dt = (sb.serverTime - sa.serverTime) / (40 * 60_000);
    expect(Math.abs(((sb.dayT - sa.dayT - dt) % 1 + 1.5) % 1 - 0.5)).toBeLessThan(1e-6);
    // And it matches the shared deterministic schedule.
    const expected = skyState("arcadia", sa.copy, sa.serverTime);
    expect(sa.weather).toBe(expected.weather);
    expect(sa.nextChangeAt).toBe(expected.nextChangeAt);
  });

  it("broadcasts an admin override to everyone on the copy", async () => {
    const admin = await bot("admin", "admin");
    const other = await bot("other");
    expect(admin.roomId).toBe(other.roomId);
    admin.send("admin", { cmd: "sky", args: { weather: "storm", intensity: 0.8, minutes: 2, dayT: 0.05 } });
    await waitFor(() => skies(other).some((s) => s.override && s.weather === "storm"));
    const s = skies(other).find((x) => x.override)!;
    expect(s.intensity).toBeCloseTo(0.8, 6);
    expect(s.nextChangeAt - s.serverTime).toBeGreaterThan(110_000);
    expect(Math.abs(s.dayT - 0.05)).toBeLessThan(0.001);
    expect(skies(admin).some((x) => x.override && x.weather === "storm")).toBe(true);
  });

  it("ignores the sky command from non-admins", async () => {
    const a = await bot("plain");
    a.send("admin", { cmd: "sky", args: { weather: "storm" } });
    a.send("skySync", {});
    await waitFor(() => skies(a).length > 0);
    expect(skies(a).some((s) => s.override)).toBe(false);
  });
});

describe("SkySystem (unit)", () => {
  it("broadcasts when the weather slot changes", () => {
    const sent: SkyState[] = [];
    const handlers = new Map<string, unknown>();
    const fakeRoom = {
      bodyDef: { id: "hollowmere" },
      state: { copy: 1 },
      onMessage: (t: string, ...rest: unknown[]) => handlers.set(t, rest),
      broadcast: (t: string, m: SkyState) => t === "sky" && sent.push(m),
    };
    let now = Date.UTC(2026, 9, 12, 5);
    const sys = new SkySystem(fakeRoom as never);
    sys.now = () => now;
    // Re-key at the injected time, then step through two slots.
    sys.tick(50, now);
    const first = sys.state(now);
    sent.length = 0;
    sys.tick(50, now + 1000);
    expect(sent).toHaveLength(0);
    now = first.nextChangeAt + 10;
    sys.tick(50, now);
    expect(handlers.has("skySync")).toBe(true);
    const changed = first.nextWeather !== first.weather || first.nextIntensity !== first.intensity;
    if (changed) expect(sent).toHaveLength(1);
    // Slot boundaries always re-key (slotStart moves), so a broadcast happens either way.
    expect(sent.length).toBe(1);
    expect(sent[0]!.slotStart).toBe(first.nextChangeAt);
  });
});

// Sky (seam 1): the real server driven by SDK bots. Two clients on the same copy get the same sky;
// slot changes are broadcast; an admin override reaches everyone on the copy.

import type { Room } from "@colyseus/sdk";
import { DAY_MS, dayT, nextStrike, skyState, type SkyState } from "@firstlight/shared";
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

  it("sends an admin override once, not every tick, and every client gets the same lightning", async () => {
    const admin = await bot("dir", "admin");
    const other = await bot("cam");
    admin.send("admin", { cmd: "sky", args: { weather: "storm", intensity: 0.8, minutes: 5 } });
    await waitFor(() => skies(other).some((s) => s.override));
    const t0 = skies(other).find((s) => s.override)!.serverTime;
    await waitFor(() => ((other.state as any).time ?? 0) - t0 >= 1500); // 30 ticks
    expect(skies(other).filter((s) => s.override)).toHaveLength(1);
    // A later re-sync describes the same storm: the same strikes as the broadcast.
    other.send("skySync", {});
    await waitFor(() => skies(other).filter((s) => s.override).length === 2);
    const [heard, synced] = skies(other).filter((s) => s.override) as [SkyState, SkyState];
    expect(synced.serverTime).toBeGreaterThan(heard.serverTime);
    expect(synced.slotStart).toBe(heard.slotStart);
    const fromAdmin = skies(admin).find((s) => s.override)!;
    for (let ms = heard.serverTime; ms < heard.serverTime + 120_000; ms += 5000) {
      expect(nextStrike(synced, ms)).toEqual(nextStrike(heard, ms));
      expect(nextStrike(fromAdmin, ms)).toEqual(nextStrike(heard, ms));
    }
    expect(nextStrike(heard, heard.serverTime)).not.toBeNull();
  });

  it("answers skySync at most once a second per client", async () => {
    const a = await bot("spam");
    for (let i = 0; i < 10; i++) a.send("skySync", {});
    await waitFor(() => skies(a).length > 0);
    const t0 = skies(a)[0]!.serverTime;
    await waitFor(() => ((a.state as any).time ?? 0) - t0 >= 1200);
    expect(skies(a)).toHaveLength(1);
    a.send("skySync", {});
    await waitFor(() => skies(a).length === 2);
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

  it("broadcasts an admin override once, then stays quiet until it ends", () => {
    const { sys, sent, step } = unit();
    sys.onAdmin(ADMIN, "sky", { weather: "storm", intensity: 0.8, minutes: 1 });
    expect(sent).toHaveLength(1);
    const until = sent[0]!.nextChangeAt;
    for (let i = 0; i < 400; i++) step(50); // 20 s of ticks
    expect(sent).toHaveLength(1);
    // Same storm re-sent with a longer duration: a new end time, so one more message.
    sys.onAdmin(ADMIN, "sky", { weather: "storm", intensity: 0.8, minutes: 2 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.nextChangeAt).toBeGreaterThan(until);
    expect(sent[1]!.slotStart).toBe(sent[0]!.slotStart + 20_000);
    // Expiry goes back to the schedule with one message.
    while (sys.now() < sent[1]!.nextChangeAt + 100) step(50);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.override).toBe(false);
  });
});

describe("SkySystem admin input", () => {
  it("falls back to defaults for non-finite numbers", () => {
    const { sys, sent } = unit();
    sys.onAdmin(ADMIN, "sky", { weather: "rain", intensity: Number.NaN, minutes: Number.NaN });
    expect(sent[0]!.intensity).toBe(0.9);
    expect(sent[0]!.nextChangeAt - sent[0]!.serverTime).toBe(15 * 60_000);
    sys.onAdmin(ADMIN, "sky", { weather: "rain", intensity: Number.POSITIVE_INFINITY, minutes: Number.POSITIVE_INFINITY });
    expect(sent[1]!.intensity).toBe(0.9);
    expect(sent[1]!.nextChangeAt - sent[1]!.serverTime).toBe(15 * 60_000);
    sys.onAdmin(ADMIN, "sky", { weather: "rain", intensity: 7, minutes: 1e9 });
    expect(sent[2]!.intensity).toBe(1);
    expect(sent[2]!.nextChangeAt - sent[2]!.serverTime).toBe(240 * 60_000);
  });
});

describe("SkySystem admin time of day", () => {
  it("a time shift lets the clock run and expires after its minutes", () => {
    const { sys, sent, step } = unit();
    sys.onAdmin(ADMIN, "sky", { dayT: 0.3, minutes: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.dayT).toBeCloseTo(0.3, 9);
    expect(sent[0]!.dayHold).toBeUndefined();
    step(30_000);
    expect(sys.state().dayT).toBeCloseTo(0.3 + 30_000 / DAY_MS, 9);
    expect(sent).toHaveLength(1);
    while (sys.now() < sent[0]!.serverTime + 60_000 + 100) step(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.dayOffset).toBe(0);
    expect(sent[1]!.dayT).toBeCloseTo(dayT("arcadia", sent[1]!.serverTime), 9);
  });

  it("hold freezes the time of day until it expires; reset clears it at once", () => {
    const { sys, sent, step } = unit();
    sys.onAdmin(ADMIN, "sky", { dayT: 0.82, hold: true, minutes: 2 });
    expect(sent[0]!.dayT).toBe(0.82);
    expect(sent[0]!.dayHold).toBe(0.82);
    for (let i = 0; i < 1200; i++) step(50); // 60 s
    expect(sent).toHaveLength(1);
    expect(sys.state().dayT).toBe(0.82);
    while (sys.now() < sent[0]!.serverTime + 120_000 + 100) step(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.dayHold).toBeUndefined();
    sys.onAdmin(ADMIN, "sky", { dayT: 0.5, hold: true, weather: "storm" });
    expect(sent[2]!.dayHold).toBe(0.5);
    sys.onAdmin(ADMIN, "sky", { clear: true });
    expect(sent[3]!.dayHold).toBeUndefined();
    expect(sent[3]!.override).toBe(false);
    expect(sent[3]!.dayOffset).toBe(0);
  });
});

const ADMIN = {} as never;

/** A SkySystem on a fake room with an injected clock. */
function unit(body = "arcadia") {
  const sent: SkyState[] = [];
  const handlers = new Map<string, unknown[]>();
  const fakeRoom = {
    bodyDef: { id: body },
    state: { copy: 0 },
    onMessage: (t: string, ...rest: unknown[]) => handlers.set(t, rest),
    broadcast: (t: string, m: SkyState) => t === "sky" && sent.push(m),
  };
  let now = Date.UTC(2026, 9, 12, 5);
  const sys = new SkySystem(fakeRoom as never);
  sys.now = () => now;
  sys.tick(50, now);
  sent.length = 0;
  const step = (ms: number) => {
    now += ms;
    sys.tick(ms, now);
  };
  return { sys, sent, step, handlers };
}

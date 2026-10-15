import { describe, expect, it } from "vitest";
import { generateTakes, parseBudget, type Job, type SpendIo } from "./spend.ts";

const job = (take: number, estimate = 5): Job => ({ name: "hitmark", take, prompt: "a thump", seconds: 0.5, influence: 0.6, file: `/nowhere/hitmark-${take}.mp3`, estimate });

/** A fake ElevenLabs: the subscription body, then one response per generation request. */
function api(subscription: unknown, generations: { status?: number; cost?: string | null }[]) {
  const calls: string[] = [];
  const saved: number[] = [];
  let i = 0;
  const io: SpendIo = {
    fetch: (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/user/subscription")) return new Response(JSON.stringify(subscription), { status: 200 });
      const g = generations[Math.min(i++, generations.length - 1)]!;
      const headers = new Headers();
      if (g.cost !== null && g.cost !== undefined) headers.set("character-cost", g.cost);
      return new Response(new Uint8Array([1, 2, 3]), { status: g.status ?? 200, headers });
    }) as typeof fetch,
    save: (j) => void saved.push(j.take),
    log: () => {},
  };
  const generated = () => calls.filter((c) => c.includes("/sound-generation")).length;
  return { io, calls, saved, generated };
}

const plenty = { character_count: 39000, character_limit: 40000 };

describe("generation budget", () => {
  it("stops at the first malformed or missing cost header (the cap can't go NaN)", async () => {
    for (const cost of ["abc", "", "5.5", "-5", null]) {
      const a = api(plenty, [{ cost }]);
      const r = await generateTakes([job(1), job(2), job(3)], 5, "k", a.io);
      expect(a.generated(), String(cost)).toBe(1);
      expect(r.stop).toMatch(/billing/);
      expect(a.saved).toEqual([1]); // paid for, so kept
      expect(r.committed).toBe(5); // the reservation stands
    }
  });

  it("reserves each take's estimate before asking, so it never passes the budget", async () => {
    const a = api(plenty, [{ cost: "5" }]);
    const r = await generateTakes([job(1), job(2), job(3)], 12, "k", a.io);
    expect(a.generated()).toBe(2);
    expect(r).toMatchObject({ billed: 10, committed: 10 });
    expect(r.stop).toMatch(/cap/);
  });

  it("never spends more than the account has left", async () => {
    const a = api({ character_count: 39994, character_limit: 40000 }, [{ cost: "5" }]);
    await generateTakes([job(1), job(2)], 100, "k", a.io);
    expect(a.generated()).toBe(1);
  });

  it("refuses bad subscription data before any paid request", async () => {
    for (const sub of [{ character_count: "x", character_limit: 40000 }, { character_count: 10 }, { character_count: 50, character_limit: 40 }, null]) {
      const a = api(sub, [{ cost: "5" }]);
      await expect(generateTakes([job(1)], 100, "k", a.io)).rejects.toThrow(/billing/);
      expect(a.generated()).toBe(0);
    }
  });

  it("stops when a take costs more than estimated (pricing changed)", async () => {
    const a = api(plenty, [{ cost: "50" }]);
    const r = await generateTakes([job(1), job(2)], 200, "k", a.io);
    expect(a.generated()).toBe(1);
    expect(r).toMatchObject({ billed: 50, committed: 50 });
    expect(r.stop).toMatch(/estimate/);
  });

  it("keeps the reservation of a failed request (it may have been billed)", async () => {
    const a = api(plenty, [{ status: 500 }, { cost: "5" }]);
    const r = await generateTakes([job(1), job(2), job(3)], 10, "k", a.io);
    expect(a.generated()).toBe(2);
    expect(r).toMatchObject({ billed: 5, committed: 10 });
    expect(a.saved).toEqual([2]);
  });

  it("stops on auth, quota and rate-limit errors", async () => {
    for (const status of [401, 402, 429]) {
      const a = api(plenty, [{ status }]);
      const r = await generateTakes([job(1), job(2)], 100, "k", a.io);
      expect(a.generated()).toBe(1);
      expect(r.stop).toMatch(String(status));
    }
  });

  it("rejects a budget that isn't a whole number of credits", () => {
    expect(parseBudget("0")).toBe(0);
    expect(parseBudget("150")).toBe(150);
    for (const bad of ["abc", "", "-1", "1e400", "2.5", undefined]) expect(() => parseBudget(bad), String(bad)).toThrow(/budget/);
  });
});

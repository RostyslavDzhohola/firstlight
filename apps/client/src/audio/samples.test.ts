import { afterEach, describe, expect, it, vi } from "vitest";
import { jitter, parseManifest, pickTake, resolveSound, SampleBank, sampleUrl, type SampleIo } from "./samples.ts";

const BASE = "https://assets.example.dev/v/sfx-1";

/** A fake asset host: files map to a buffer id, a thrown Error, or nothing (404). */
function host(manifest: unknown, files: Record<string, string | Error>) {
  const requested: string[] = [];
  const io: SampleIo<string> = {
    json: async (url) => {
      requested.push(url);
      if (manifest instanceof Error) throw manifest;
      return manifest;
    },
    buffer: async (url) => {
      requested.push(url);
      const f = files[url.slice(BASE.length + 1)];
      if (f === undefined) throw new Error("404");
      if (f instanceof Error) throw f; // decodeAudioData rejecting a corrupt file
      return f;
    },
  };
  return { io, requested };
}

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};

afterEach(() => vi.restoreAllMocks());

describe("sample manifest", () => {
  it("keeps known sounds with safe file names and a sane gain", () => {
    const m = parseManifest({
      set: "sfx-1",
      sounds: {
        hitmark: { files: ["hitmark-1.mp3", "hitmark-2.mp3"], gain: 0.7 },
        swing_sword: { files: ["swing_sword-1.mp3"], gain: 99 },
        not_a_sound: { files: ["x.mp3"], gain: 1 },
        ui: { files: ["../secret.mp3", "a/b.mp3", "https://evil.example/x.mp3", 3], gain: 1 },
      },
    });
    expect(m.set).toBe("sfx-1");
    expect(m.sounds.hitmark).toEqual({ files: ["hitmark-1.mp3", "hitmark-2.mp3"], gain: 0.7 });
    expect(m.sounds.swing_sword).toEqual({ files: ["swing_sword-1.mp3"], gain: 1 }); // gain out of range -> 1
    expect(m.sounds).not.toHaveProperty("not_a_sound");
    expect(m.sounds).not.toHaveProperty("ui"); // no usable file left
  });

  it("treats junk as an empty set", () => {
    for (const junk of [null, 3, "x", [], { sounds: 5 }]) expect(parseManifest(junk).sounds).toEqual({});
  });

  it("joins the base and the file once", () => {
    expect(sampleUrl(`${BASE}/`, "ui-1.mp3")).toBe(`${BASE}/ui-1.mp3`);
    expect(sampleUrl(BASE, "manifest.json")).toBe(`${BASE}/manifest.json`);
  });
});

describe("takes and jitter", () => {
  it("never repeats the previous take when there are two or more", () => {
    for (const n of [2, 3]) {
      let last = -1;
      const rnd = seq(0, 0.99, 0.5, 0.2, 0.7, 0.01);
      for (let k = 0; k < 40; k++) {
        const i = pickTake(n, last, rnd);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
        expect(i).not.toBe(last);
        last = i;
      }
    }
    expect(pickTake(1, 0)).toBe(0);
  });

  it("varies pitch by ±6 % and level by −1.5 dB…0", () => {
    expect(jitter(() => 0)).toEqual({ rate: 0.94, gain: 0.84 });
    const hi = jitter(() => 0.999999);
    expect(hi.rate).toBeCloseTo(1.06, 4);
    expect(hi.gain).toBeCloseTo(1, 4);
  });
});

describe("sample bank and the ZzFX fallback", () => {
  it("plays samples it loaded and ZzFX for everything else", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { io } = host(
      {
        set: "sfx-1",
        sounds: {
          hitmark: { files: ["hitmark-1.mp3", "hitmark-2.mp3"], gain: 0.5 },
          swing_sword: { files: ["swing_sword-1.mp3"], gain: 1 }, // 404
          hexquill: { files: ["hexquill-1.mp3", "hexquill-2.mp3"], gain: 2 }, // one corrupt take
        },
      },
      { "hitmark-1.mp3": "H1", "hitmark-2.mp3": "H2", "hexquill-1.mp3": new Error("decode"), "hexquill-2.mp3": "Q2" },
    );
    const bank = new SampleBank(io);
    expect(await bank.load(BASE)).toBe(2);
    expect(console.warn).toHaveBeenCalledOnce();

    const hit = resolveSound("hitmark", bank, () => 0);
    expect(hit).toMatchObject({ kind: "sample", buffer: "H1", rate: 0.94 });
    expect(hit.gain).toBeCloseTo(0.5 * 0.84);
    expect(resolveSound("hitmark", bank, () => 0)).toMatchObject({ buffer: "H2" }); // no immediate repeat
    expect(resolveSound("hexquill", bank)).toMatchObject({ kind: "sample", buffer: "Q2" }); // the good take
    // The missing file and sounds outside the set fall back to their presets, with the stand-in's gain and rate.
    expect(resolveSound("swing_sword", bank)).toEqual({ kind: "zzfx", preset: "swing", gain: 1, rate: 1 });
    expect(resolveSound("crit", bank)).toEqual({ kind: "zzfx", preset: "hitmark", gain: 1.3, rate: 1.3 });
    expect(resolveSound("whistle", bank)).toEqual({ kind: "zzfx", preset: "whistle", gain: 1, rate: 1 });
  });

  it("falls back to ZzFX for every sound when the manifest is missing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { io, requested } = host(new Error("404"), {});
    const bank = new SampleBank(io);
    expect(await bank.load(BASE)).toBe(0);
    expect(requested).toEqual([`${BASE}/manifest.json`]); // one request, no per-file 404s
    expect(bank.has("hitmark")).toBe(false);
    expect(resolveSound("carbine", bank)).toEqual({ kind: "zzfx", preset: "carbine", gain: 1, rate: 1 });
    expect(resolveSound("shatter", null)).toEqual({ kind: "zzfx", preset: "meleeHit", gain: 1, rate: 0.7 });
  });
});

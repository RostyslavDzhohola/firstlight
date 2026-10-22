import { describe, expect, it } from "vitest";
import { measurePassCosts, type PassConfig, type PassCostHost } from "./passCost.ts";

/**
 * A renderer stand-in with known costs: the baseline frame costs `base` ms, each feature adds its
 * cost while on, and GTAO costs scale with samples × resolution². Each batch adds deterministic
 * jitter (± `jitter` ms per frame) so noise handling is exercised.
 */
function fakeHost(opts: {
  base?: number;
  costs: Record<string, number>;
  /** Features the tier has off. */
  offAtTier?: string[];
  jitter?: number;
  /** Shader builds added by the Nth measured batch (0-based). */
  buildsOnBatch?: number;
  hideOnBatch?: number;
  throwOnBatch?: number;
  cpuMs?: number;
}) {
  const base = opts.base ?? 10;
  const jitter = opts.jitter ?? 0.05;
  let config: PassConfig = { off: new Set() };
  let builds = 0;
  let batch = 0;
  let hidden = false;
  let now = 0;
  const configs: PassConfig[] = [];
  let warms = 0;
  const host: PassCostHost & { configs: PassConfig[]; warms: () => number; current: () => PassConfig } = {
    features: Object.keys(opts.costs),
    isOn: (f) => !(opts.offAtTier ?? []).includes(f),
    async configure(c) {
      config = c;
      configs.push(c);
    },
    async warm() {
      warms++;
    },
    async renderBatch(frames) {
      const i = batch++;
      if (opts.throwOnBatch === i) throw new Error("device lost");
      if (opts.buildsOnBatch === i) builds += 2;
      if (opts.hideOnBatch === i) hidden = true;
      let ms = base;
      for (const [f, c] of Object.entries(opts.costs)) if (!config.off.has(f) && host.isOn(f)) ms += c;
      if (config.ao && !config.off.has("ao")) {
        // Replace the default AO cost (16 samples, half res) by one scaled to the override.
        const def = opts.costs.ao ?? 0;
        ms += def * ((config.ao.samples / 16) * (config.ao.scale / 0.5) ** 2) - def;
      }
      const j = (((i * 7919) % 11) / 10 - 0.5) * 2 * jitter;
      const wall = (ms + j) * frames;
      now += wall;
      return { wallMs: wall, cpuMs: (opts.cpuMs ?? 2) * frames };
    },
    shaderBuilds: () => builds,
    visible: () => !hidden,
    configs,
    warms: () => warms,
    current: () => config,
  };
  return host;
}

describe("measurePassCosts", () => {
  it("recovers each pass's cost as the baseline minus the pass switched off, ranked by cost", async () => {
    const host = fakeHost({ costs: { grass: 3, bloom: 0.8, shadows: 2, fxaa: 0.3 } });
    const r = await measurePassCosts(host, { rounds: 6, framesPerBatch: 16 });
    expect(r.valid).toBe(true);
    expect(r.baseline.p50).toBeCloseTo(16.1, 0);
    const by = Object.fromEntries(r.passes.map((p) => [p.feature, p]));
    expect(by.grass!.deltaMs.p50).toBeCloseTo(3, 0);
    expect(by.shadows!.deltaMs.p50).toBeCloseTo(2, 0);
    expect(by.bloom!.deltaMs.p50).toBeCloseTo(0.8, 0);
    expect(r.passes.map((p) => p.feature)).toEqual(["grass", "shadows", "bloom", "fxaa"]);
    expect(r.method).toBe("wall-clock-batch");
    expect(r.framesPerBatch).toBe(16);
    expect(r.rounds).toBe(6);
  });

  it("flags deltas within the noise floor", async () => {
    const host = fakeHost({ costs: { grass: 3, grain: 0.01 }, jitter: 0.3 });
    const r = await measurePassCosts(host, { rounds: 8 });
    const by = Object.fromEntries(r.passes.map((p) => [p.feature, p]));
    expect(r.noiseMs).toBeGreaterThan(0);
    expect(by.grain!.belowNoise).toBe(true);
    expect(by.grass!.belowNoise).toBe(false);
  });

  it("lists features the tier has off as skipped and never measures them", async () => {
    const host = fakeHost({ costs: { grass: 3, ao: 1.5, traa: 1 }, offAtTier: ["ao", "traa"] });
    const r = await measurePassCosts(host, { rounds: 2 });
    expect(r.skipped).toEqual(["ao", "traa"]);
    expect(r.passes.map((p) => p.feature)).toEqual(["grass"]);
    expect(host.configs.some((c) => c.off.has("ao") || c.ao)).toBe(false);
    expect(r.gtao).toBeNull();
  });

  it("warms every configuration before its measured batch", async () => {
    const host = fakeHost({ costs: { grass: 3, bloom: 1 } });
    const r = await measurePassCosts(host, { rounds: 3 });
    // Each measured batch follows a configure + warm: baseline twice a round, then each feature.
    expect(host.warms()).toBe(host.configs.length - 1); // the last configure is the restore
    expect(r.valid).toBe(true);
  });

  it("is invalid when a shader builds during a measured batch", async () => {
    const r = await measurePassCosts(fakeHost({ costs: { grass: 3 }, buildsOnBatch: 2 }), { rounds: 3 });
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toMatch(/shader/);
    expect(r.shaderBuildsDuringMeasure).toBe(2);
  });

  it("is invalid when the tab is hidden during the run", async () => {
    const r = await measurePassCosts(fakeHost({ costs: { grass: 3 }, hideOnBatch: 1 }), { rounds: 3 });
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toMatch(/hidden/);
  });

  it("restores the baseline settings when a batch throws, and reports the error", async () => {
    const host = fakeHost({ costs: { grass: 3, bloom: 1 }, throwOnBatch: 3 });
    const r = await measurePassCosts(host, { rounds: 3 });
    expect(r.valid).toBe(false);
    expect(r.invalidReason).toMatch(/device lost/);
    expect(host.current().off.size).toBe(0);
    expect(host.current().ao ?? null).toBeNull();
  });

  it("restores the baseline settings after a clean run", async () => {
    const host = fakeHost({ costs: { grass: 3, ao: 1.2 } });
    await measurePassCosts(host, { rounds: 2, gtao: true });
    expect(host.current().off.size).toBe(0);
    expect(host.current().ao ?? null).toBeNull();
  });

  it("sweeps GTAO samples × resolution, each priced against AO off", async () => {
    const host = fakeHost({ costs: { grass: 3, ao: 1.6 } });
    const r = await measurePassCosts(host, { rounds: 4, gtao: true });
    expect(r.gtao).not.toBeNull();
    const g = r.gtao!;
    expect(g.map((e) => [e.samples, e.scale])).toEqual([[16, 1], [16, 0.5], [8, 1], [8, 0.5], [4, 1], [4, 0.5]]);
    const at = (s: number, sc: number) => g.find((e) => e.samples === s && e.scale === sc)!;
    expect(at(16, 0.5).costMs.p50).toBeCloseTo(1.6, 0);
    expect(at(16, 1).costMs.p50).toBeCloseTo(6.4, 0);
    expect(at(4, 0.5).costMs.p50).toBeCloseTo(0.4, 0);
  });

  it("reports the CPU share so CPU-bound deltas aren't read as GPU cost", async () => {
    const r = await measurePassCosts(fakeHost({ costs: { grass: 3 }, cpuMs: 15 }), { rounds: 2 });
    expect(r.baseline.cpuMs).toBeCloseTo(15, 5);
    expect(r.cpuBound).toBe(true);
    const r2 = await measurePassCosts(fakeHost({ costs: { grass: 3 }, cpuMs: 2 }), { rounds: 2 });
    expect(r2.cpuBound).toBe(false);
  });

  it("measures only the requested features when a list is given", async () => {
    const host = fakeHost({ costs: { grass: 3, bloom: 1, fxaa: 0.2 } });
    const r = await measurePassCosts(host, { rounds: 2, only: ["bloom"] });
    expect(r.passes.map((p) => p.feature)).toEqual(["bloom"]);
  });

  it("shows the sum of the deltas next to the baseline", async () => {
    const r = await measurePassCosts(fakeHost({ base: 5, costs: { grass: 3, bloom: 1 } }), { rounds: 4 });
    expect(r.sumOfDeltasMs).toBeCloseTo(4, 0);
  });
});

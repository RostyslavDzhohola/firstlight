import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { ArtPacks, type ArtPacksEnv, type TextureSlot } from "./ArtPacks.ts";
import type { PackFile, PackManifest } from "./catalog.ts";

const file = (pack: PackFile["pack"], group: string, name: string, w = 2048, extra: Partial<PackFile> = {}): PackFile => ({
  pack, group, file: `${pack}/${name}`, bytes: 100, sha256: `hd:${name}`, baseSha256: `base:${name}`, width: w, height: w, ...extra,
});

const MANIFEST: PackManifest = {
  version: 1,
  files: {
    "portus/portus_color.webp": file("town", "town:portus", "portus_color.webp", 2048, { height: 8192, layerSize: 1024, layers: 16, cols: 2 }),
    "portus/portus_normal.webp": file("town", "town:portus", "portus_normal.webp", 2048, { height: 8192, layerSize: 1024, layers: 16, cols: 2 }),
    "outposts/meridian/meridian_color.webp": file("town", "town:meridian", "meridian_color.webp", 1024, { height: 9216, layerSize: 1024, layers: 9, cols: 1 }),
    "characters/ash_albedo.webp": file("chars", "chars:ash", "ash_albedo.webp"),
    "characters/ash_normal.webp": file("chars", "chars:ash", "ash_normal.webp"),
    "vegetation/vegetation.glb#vegetation_atlas": file("vegetation", "vegetation", "atlas.webp", 4096),
  },
};

/** A texture slot as a material holds it: what it draws now. */
class Slot implements TextureSlot {
  sets: THREE.Texture[] = [];
  constructor(public texture: THREE.Texture) {}
  set(t: THREE.Texture) {
    this.texture = t;
    this.sets.push(t);
  }
}

function tex(name: string, size?: [number, number]): THREE.Texture {
  const t = new THREE.Texture(size ? ({ width: size[0], height: size[1] } as never) : undefined);
  t.name = name;
  return t;
}

/** The shipped sizes: 512² strip layers, 1024² character maps, the 2048² vegetation atlas. */
const SHIPPED: Record<string, [number, number]> = {
  "portus/portus_color.webp": [512, 512 * 16],
  "portus/portus_normal.webp": [512, 512 * 16],
  "outposts/meridian/meridian_color.webp": [512, 512 * 9],
  "characters/ash_albedo.webp": [1024, 1024],
  "characters/ash_normal.webp": [1024, 1024],
  "vegetation/vegetation.glb#vegetation_atlas": [2048, 2048],
};

/** A world with the given shipped textures loaded, downloads settled by hand, and a recording uploader. */
function world(loaded: string[] = ["portus/portus_color.webp", "portus/portus_normal.webp", "characters/ash_albedo.webp", "characters/ash_normal.webp", "vegetation/vegetation.glb#vegetation_atlas"]) {
  const slots = new Map<string, Slot>();
  const disposed = new Set<THREE.Texture>();
  const watch = (t: THREE.Texture) => {
    t.addEventListener("dispose", () => disposed.add(t));
    return t;
  };
  for (const k of loaded) slots.set(k, new Slot(watch(tex(`base ${k}`, SHIPPED[k]))));
  const downloads: { entry: string; signal: AbortSignal; resolve: (b: Uint8Array) => void; reject: (e: Error) => void }[] = [];
  const uploads: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let clock = 0;
  const env: ArtPacksEnv = {
    manifest: async () => MANIFEST,
    download: (entry, signal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        downloads.push({ entry: entry.base, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    slot: (base) => {
      const s = slots.get(base);
      return s ? { slot: s, sha256: `base:${MANIFEST.files[base]!.file.split("/").pop()}` } : null;
    },
    make: async (entry) => watch(tex(`hd ${entry.base}`)),
    uploadSteps: (t) => [() => uploads.push(`${t.name} 1/2`), () => uploads.push(`${t.name} 2/2`)],
    later: (fn, ms) => {
      const t = { at: clock + ms, fn };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
    now: () => clock,
  };
  const tick = async (ms = 0) => {
    clock += ms;
    for (const t of [...timers].filter((x) => x.at <= clock)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Let every download in flight land, then flush promises. */
  const land = async () => {
    for (;;) {
      const d = downloads.find((x) => !x.signal.aborted && !(x as { done?: boolean }).done);
      if (!d) break;
      (d as { done?: boolean }).done = true;
      d.resolve(new Uint8Array(4));
      await tick();
    }
  };
  /** Frames until nothing more uploads or swaps. */
  const frames = async (packs: ArtPacks, n = 64) => {
    for (let i = 0; i < n; i++) {
      packs.frame();
      await tick();
    }
  };
  return { env, slots, disposed, downloads, uploads, tick, land, frames, watch };
}

describe("ArtPacks", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("downloads nothing before play resumes, then only after the start delay, one group at a time", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("medium");
    await w.tick(60_000);
    expect(w.downloads).toEqual([]); // never before control
    packs.resume();
    await w.tick(100);
    expect(w.downloads).toEqual([]); // not while the arrival's own late downloads may still run
    await w.tick(ArtPacks.START_DELAY_MS);
    expect(w.downloads.map((d) => d.entry)).toEqual(["portus/portus_color.webp", "portus/portus_normal.webp"]);
  });

  it("waits for the arrival's own downloads still running in play (a site asset past its deadline)", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("medium");
    let settle!: () => void;
    packs.resume({ after: new Promise<void>((r) => (settle = r)) });
    await w.tick(ArtPacks.START_DELAY_MS * 10);
    expect(w.downloads).toEqual([]);
    expect(packs.state().busy).toBe(true);
    settle();
    await w.tick();
    expect(w.downloads.length).toBe(2);
  });

  it("a pause while waiting for them cancels the start", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("medium");
    let settle!: () => void;
    packs.resume({ after: new Promise<void>((r) => (settle = r)) });
    await w.tick(ArtPacks.START_DELAY_MS);
    packs.pause();
    settle();
    await w.tick(ArtPacks.START_DELAY_MS);
    expect(w.downloads).toEqual([]);
    expect(packs.state().busy).toBe(false);
  });

  it("swaps a group into the same slots only when every file of it is uploaded, then releases the base on the GPU", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("medium");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    const color = w.slots.get("portus/portus_color.webp")!, normal = w.slots.get("portus/portus_normal.webp")!;
    const base = [color.texture, normal.texture];
    await w.land();
    packs.frame(); // first slice of the colour strip
    await w.tick();
    expect(color.sets).toEqual([]);
    packs.frame();
    packs.frame();
    await w.tick();
    expect(color.sets, "not before the normal strip is in too").toEqual([]);
    packs.frame(); // the last slice
    await w.tick();
    expect(color.sets, "the swap gets its own frame").toEqual([]);
    packs.frame();
    await w.tick();
    expect(w.uploads).toEqual([
      "hd portus/portus_color.webp 1/2", "hd portus/portus_color.webp 2/2",
      "hd portus/portus_normal.webp 1/2", "hd portus/portus_normal.webp 2/2",
    ]);
    expect(color.texture.name).toBe("hd portus/portus_color.webp");
    expect(normal.texture.name).toBe("hd portus/portus_normal.webp");
    for (const b of base) expect(w.disposed.has(b)).toBe(true);
    expect(packs.state().live).toContain("town:portus");
  });

  it("goes through every wanted group, skipping what isn't loaded in this session (Meridian's strip from Portus)", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("high");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    for (let i = 0; i < 6; i++) {
      await w.land();
      await w.frames(packs, 8);
    }
    expect(packs.state().live.sort()).toEqual(["chars:ash", "town:portus", "vegetation"]);
    expect(w.downloads.map((d) => d.entry)).not.toContain("outposts/meridian/meridian_color.webp");
  });

  it("a site loaded later (travel to Meridian) gets its group at the next resume", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "on", only: ["town"] });
    packs.setTier("medium");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    await w.land();
    await w.frames(packs, 8);
    expect(packs.state().live).toEqual(["town:portus"]);
    packs.pause(); // the travel's loading screen
    w.slots.set("outposts/meridian/meridian_color.webp", new Slot(tex("base meridian")));
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    await w.land();
    await w.frames(packs, 8);
    expect(packs.state().live.sort()).toEqual(["town:meridian", "town:portus"]);
  });

  it("a failed download keeps the shipped textures and frees what had arrived; a later resume tries once more, then stops", async () => {
    const w = world(["characters/ash_albedo.webp", "characters/ash_normal.webp"]);
    const packs = new ArtPacks(w.env, { mode: "on", only: ["chars"] });
    packs.setTier("medium");
    const albedo = w.slots.get("characters/ash_albedo.webp")!;
    const base = albedo.texture;
    for (let attempt = 0; attempt < 3; attempt++) {
      packs.resume();
      await w.tick(ArtPacks.START_DELAY_MS);
      const [a, n] = w.downloads.slice(-2);
      a!.resolve(new Uint8Array(4));
      await w.tick();
      n!.reject(new Error("offline"));
      await w.tick();
      await w.frames(packs, 4);
      packs.pause();
    }
    expect(w.downloads.length, "two attempts per session").toBe(4);
    expect(albedo.texture).toBe(base);
    expect(albedo.sets).toEqual([]);
    expect(w.disposed.has(base)).toBe(false);
    // The albedo that arrived each time was made into a texture and released again.
    expect([...w.disposed].map((t) => t.name)).toEqual(expect.arrayContaining(["hd characters/ash_albedo.webp"]));
    expect(packs.state().failed).toEqual(["chars:ash"]);
  });

  it("a file built for another base (hash mismatch) is never swapped in", async () => {
    const w = world(["characters/ash_albedo.webp", "characters/ash_normal.webp"]);
    w.env.slot = (base) => {
      const s = w.slots.get(base);
      return s ? { slot: s, sha256: "something else" } : null;
    };
    const packs = new ArtPacks(w.env, { mode: "on", only: ["chars"] });
    packs.setTier("medium");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    expect(w.downloads).toEqual([]);
    expect(packs.state().failed).toEqual(["chars:ash"]);
  });

  it("pausing (a loading screen) aborts the download in flight and drops a half-uploaded group", async () => {
    const w = world(["characters/ash_albedo.webp", "characters/ash_normal.webp"]);
    const packs = new ArtPacks(w.env, { mode: "on", only: ["chars"] });
    packs.setTier("medium");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    const [a] = w.downloads;
    a!.resolve(new Uint8Array(4));
    await w.tick();
    packs.pause();
    await w.tick();
    expect(w.downloads.every((d) => d.signal.aborted || d === a)).toBe(true);
    expect([...w.disposed].map((t) => t.name)).toContain("hd characters/ash_albedo.webp");
    expect(w.slots.get("characters/ash_albedo.webp")!.sets).toEqual([]);
    // and it starts over after the next hand-over (an aborted try isn't a failure)
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    await w.land();
    await w.frames(packs, 8);
    expect(packs.state().live).toEqual(["chars:ash"]);
  });

  it("a tier that doesn't take a pack puts the shipped textures back and releases the HD ones; going back up loads them again", async () => {
    const w = world(["characters/ash_albedo.webp", "characters/ash_normal.webp"]);
    const packs = new ArtPacks(w.env, { mode: "auto" });
    packs.setTier("medium");
    const albedo = w.slots.get("characters/ash_albedo.webp")!;
    const base = albedo.texture;
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    await w.land();
    await w.frames(packs, 8);
    const hd = albedo.texture;
    expect(hd).not.toBe(base);
    packs.pause();
    packs.setTier("low"); // behind the graphics loading screen, before its warm-up
    expect(albedo.texture).toBe(base);
    expect(w.disposed.has(hd)).toBe(true);
    expect(packs.state().live).toEqual([]);
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    expect(w.downloads.length, "Low downloads nothing").toBe(2);
    packs.pause();
    packs.setTier("high");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    await w.land();
    await w.frames(packs, 8);
    expect(albedo.texture).not.toBe(base);
    expect(packs.state().live).toEqual(["chars:ash"]);
  });

  it("a base texture replaced by someone else meanwhile (a 512² → 1024² raise) is not swapped from a stale base", async () => {
    const w = world(["characters/ash_albedo.webp", "characters/ash_normal.webp"]);
    const packs = new ArtPacks(w.env, { mode: "on", only: ["chars"] });
    packs.setTier("medium");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    const albedo = w.slots.get("characters/ash_albedo.webp")!;
    const raised = w.watch(tex("raised 1024", [1024, 1024]));
    albedo.texture = raised; // D-load-6 swapped it behind a loading screen while we downloaded
    await w.land();
    await w.frames(packs, 8);
    // the group restarts from the new base and swaps it (never re-binds the stale one)
    await w.land();
    await w.frames(packs, 8);
    expect(albedo.texture.name).toBe("hd characters/ash_albedo.webp");
    expect(w.disposed.has(raised)).toBe(true);
  });

  it("stays within the GPU budget: a group that would pass it is left out", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "auto" }, { budgetBytes: 100 * 1024 * 1024 });
    packs.setTier("ultra");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS);
    for (let i = 0; i < 6; i++) {
      await w.land();
      await w.frames(packs, 8);
    }
    // town:portus adds ≈ 171 MiB − 43 MiB = 128 MiB: over 100 MiB on its own; chars (32) and vegetation (64) fit
    expect(packs.state().live).not.toContain("town:portus");
    expect(packs.state().skipped).toEqual(["town:portus"]);
    expect(packs.state().live.sort()).toEqual(["chars:ash", "vegetation"]);
    expect(packs.state().gpuBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it("an off switch downloads nothing on any tier", async () => {
    const w = world();
    const packs = new ArtPacks(w.env, { mode: "off" });
    packs.setTier("ultra");
    packs.resume();
    await w.tick(ArtPacks.START_DELAY_MS * 3);
    expect(w.downloads).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

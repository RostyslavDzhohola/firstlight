// HD art packs after arrival (#48, D-artpacks): the session's controller. After a hand-over (play
// resumed, the arrival's own downloads done) and a short delay, it works through the packs the tier
// takes (catalog.ts), one swap group at a time: download (verified), decode off the main thread, upload
// in slices, one per frame, while the shipped textures keep drawing, then rebind the group's textures
// in the same materials in one frame (no new programs) and release the shipped ones on the GPU.
//
// A loading screen (travel, a graphics change) pauses it: the download in flight is aborted, a group
// half uploaded is dropped. A tier that doesn't take a pack puts the shipped textures back (they upload
// again behind that loading screen's warm-up) and releases the HD ones. A failed download keeps the
// shipped textures; each group gets two tries per session. The env is injected (tests drive it by hand).

import type * as THREE from "three/webgpu";
import type { Tier } from "../quality.ts";
import { GPU_PACK_BUDGET_BYTES, packsFor, textureGpuBytes, wantedGroups, type PackChoice, type PackEntry, type PackId, type PackManifest } from "./catalog.ts";

/** Where a material (or a set of them) draws a texture from: rebinding it changes no program. */
export interface TextureSlot {
  readonly texture: THREE.Texture;
  set(t: THREE.Texture): void;
}

export interface ArtPacksEnv {
  /** The pack manifest (fetched once; null when there is none or it failed). */
  manifest(): Promise<PackManifest | null>;
  /** A pack file's bytes, checked against its SHA-256. */
  download(entry: PackEntry, signal: AbortSignal): Promise<Uint8Array>;
  /** The slot of a shipped texture loaded in this session (null: not loaded) and its file's SHA-256 if the client knows it. */
  slot(base: string): { slot: TextureSlot; sha256: string | null } | null;
  /** Decode a file into a texture of the same type, format and sampler as `like` (not uploaded yet). */
  make(entry: PackEntry, bytes: Uint8Array, like: THREE.Texture, signal: AbortSignal): Promise<THREE.Texture>;
  /** The upload of `t` in steps, one per frame (array textures by layers; the last step frees the CPU copy). */
  uploadSteps(t: THREE.Texture): (() => void)[];
  later(fn: () => void, ms: number): () => void;
  now(): number;
}

type GroupState = "pending" | "loading" | "uploading" | "live" | "failed" | "skipped";

interface Live {
  slot: TextureSlot;
  base: THREE.Texture;
  hd: THREE.Texture;
}

interface Group {
  id: string;
  pack: PackId;
  files: PackEntry[];
  state: GroupState;
  tries: number;
  /** A try failed in this stretch of play: the next one waits for the next resume. */
  cooling: boolean;
  /** In flight: the files' slots and bases as they were when it started, the HD textures made so far. */
  bases: { slot: TextureSlot; base: THREE.Texture }[];
  made: THREE.Texture[];
  steps: (() => void)[];
  live: Live[];
  /** HD minus shipped GPU bytes once live (or while in flight). */
  gpuBytes: number;
  abort: AbortController | null;
}

export interface SwapRecord {
  group: string;
  /** ms since the controller's clock origin. */
  at: number;
  steps: number;
  /** The longest single upload step on the main thread (ms). */
  maxStepMs: number;
  /** The rebind itself (ms). */
  swapMs: number;
}

export interface ArtPacksState {
  tier: Tier | null;
  packs: PackId[];
  live: string[];
  failed: string[];
  skipped: string[];
  /** HD minus shipped GPU bytes of the live groups. */
  gpuBytes: number;
  swaps: SwapRecord[];
  busy: boolean;
}

/** GPU bytes of a live texture (RGBA8 with mips), from its image's size. */
export function liveTextureBytes(t: THREE.Texture): number {
  const img = t.image as { width?: number; height?: number; depth?: number } | null | undefined;
  if (!img?.width || !img.height) return 0;
  const layers = (t as THREE.DataArrayTexture).isDataArrayTexture ? img.depth ?? 1 : 1;
  return Math.round((img.width * img.height * layers * 16) / 3);
}

const MAX_TRIES = 2;

export class ArtPacks {
  /** After a hand-over, wait this long before the first download (the arrival's late downloads, the first frames of play). */
  static START_DELAY_MS = 3000;

  private tier: Tier | null = null;
  private packs: PackId[] = [];
  private manifestP: Promise<PackManifest | null> | null = null;
  private readonly groups = new Map<string, Group>();
  private running = false;
  private cancelStart: (() => void) | null = null;
  private current: Group | null = null;
  private stepMs = 0;
  readonly swaps: SwapRecord[] = [];
  private readonly budget: number;

  constructor(
    private readonly env: ArtPacksEnv,
    private readonly choice: PackChoice,
    opts: { budgetBytes?: number } = {},
  ) {
    this.budget = opts.budgetBytes ?? GPU_PACK_BUDGET_BYTES;
  }

  /**
   * The session's tier (call behind each loading screen, before its warm-up). Packs the tier no longer
   * takes go back to the shipped textures now, so the warm-up uploads those; new ones wait for resume().
   */
  setTier(tier: Tier) {
    this.tier = tier;
    this.packs = packsFor(tier, this.choice);
    for (const g of this.groups.values()) {
      if (this.packs.includes(g.pack)) continue;
      if (g.state === "loading" || g.state === "uploading") this.drop(g);
      if (g.state === "live") this.rollback(g);
      if (g.state === "skipped") g.state = "pending";
    }
  }

  /** Play resumed after a loading screen: start (after the delay) on whatever the tier takes and isn't in yet. */
  resume() {
    for (const g of this.groups.values()) g.cooling = false;
    if (this.running || this.cancelStart || !this.packs.length) return;
    this.cancelStart = this.env.later(() => {
      this.cancelStart = null;
      this.running = true;
      void this.pump();
    }, ArtPacks.START_DELAY_MS);
  }

  /** A loading screen: stop downloading and uploading (the arrival's own downloads come first). */
  pause() {
    this.cancelStart?.();
    this.cancelStart = null;
    this.running = false;
    if (this.current && (this.current.state === "loading" || this.current.state === "uploading")) this.drop(this.current);
    this.current = null;
  }

  /** One upload step of the group in flight, or its swap once every step is done. Call once per frame, before the render. */
  frame() {
    const g = this.current;
    if (!g || g.state !== "uploading" || !this.running) return;
    const step = g.steps.shift();
    if (step) {
      const t0 = this.env.now();
      step();
      this.stepMs = Math.max(this.stepMs, this.env.now() - t0);
      return;
    }
    this.swap(g);
    this.current = null;
    void this.pump();
  }

  state(): ArtPacksState {
    const of = (s: GroupState) => [...this.groups.values()].filter((g) => g.state === s).map((g) => g.id);
    return {
      tier: this.tier,
      packs: [...this.packs],
      live: of("live"),
      failed: of("failed"),
      skipped: of("skipped"),
      gpuBytes: this.liveBytes(),
      swaps: [...this.swaps],
      busy: !!this.current || !!this.cancelStart,
    };
  }

  /** Release every HD texture (the session ends). */
  dispose() {
    this.pause();
    for (const g of this.groups.values()) if (g.state === "live") this.rollback(g);
  }

  private liveBytes(except?: Group): number {
    let n = 0;
    for (const g of this.groups.values()) if (g !== except && (g.state === "live" || g.state === "loading" || g.state === "uploading")) n += g.gpuBytes;
    return n;
  }

  /** Start the next group that can go, if nothing is in flight. */
  private async pump() {
    if (!this.running || this.current) return;
    this.manifestP ??= this.env.manifest().catch(() => null);
    const manifest = await this.manifestP;
    if (!manifest || !this.running || this.current) return;
    for (const w of wantedGroups(manifest, this.packs)) {
      let g = this.groups.get(w.group);
      if (!g) {
        g = { id: w.group, pack: w.pack, files: w.files, state: "pending", tries: 0, cooling: false, bases: [], made: [], steps: [], live: [], gpuBytes: 0, abort: null };
        this.groups.set(g.id, g);
      }
      if (g.state !== "pending" || g.cooling || g.tries >= MAX_TRIES) continue;
      const slots = g.files.map((f) => this.env.slot(f.base));
      if (slots.some((s) => !s)) continue; // not loaded in this session (yet): another body's site
      if (slots.some((s, i) => s!.sha256 !== null && s!.sha256 !== g.files[i]!.baseSha256)) {
        console.warn(`[packs] ${g.id} was built for other shipped files; keeping them`);
        g.state = "failed";
        continue;
      }
      const bases = slots.map((s) => ({ slot: s!.slot, base: s!.slot.texture }));
      const bytes = g.files.reduce((n, f, i) => n + textureGpuBytes(f) - liveTextureBytes(bases[i]!.base), 0);
      if (this.liveBytes(g) + bytes > this.budget) {
        g.state = "skipped";
        continue;
      }
      g.bases = bases;
      g.gpuBytes = bytes;
      this.start(g);
      return;
    }
  }

  private start(g: Group) {
    this.current = g;
    g.state = "loading";
    g.made = [];
    g.steps = [];
    this.stepMs = 0;
    const abort = (g.abort = new AbortController());
    const { signal } = abort;
    const files = g.files.map(async (f, i) => {
      const bytes = await this.env.download(f, signal);
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const t = await this.env.make(f, bytes, g.bases[i]!.base, signal);
      if (signal.aborted || g.state !== "loading" || g.abort !== abort) {
        t.dispose(); // given up meanwhile: nothing is uploaded or bound
        throw signal.reason ?? new Error("aborted");
      }
      g.made[i] = t;
      return t;
    });
    Promise.all(files).then(
      (made) => {
        if (g.abort !== abort || g.state !== "loading") return;
        g.state = "uploading";
        g.steps = made.flatMap((t) => this.env.uploadSteps(t));
      },
      (e: unknown) => {
        if (g.abort !== abort) return; // dropped (pause / tier): already cleaned up
        g.tries++;
        console.warn(`[packs] ${g.id} didn't load${g.tries >= MAX_TRIES ? "; keeping the shipped textures for this session" : "; trying again after the next loading screen"}`, e);
        this.release(g);
        g.state = g.tries >= MAX_TRIES ? "failed" : "pending";
        g.cooling = true;
        if (this.current === g) this.current = null;
        abort.abort();
        void this.pump();
      },
    );
  }

  /** Bind the group's HD textures in its slots (one frame), release the shipped ones on the GPU. */
  private swap(g: Group) {
    // A base replaced meanwhile (the 1024² raise behind a loading screen): start again from the new one.
    if (g.bases.some((b) => b.slot.texture !== b.base)) {
      this.release(g);
      g.state = "pending";
      return;
    }
    const t0 = this.env.now();
    g.live = g.bases.map((b, i) => ({ slot: b.slot, base: b.base, hd: g.made[i]! }));
    for (const l of g.live) l.slot.set(l.hd);
    for (const l of g.live) l.base.dispose(); // its CPU copy stays: a tier change can bind it again
    g.made = [];
    g.abort = null;
    g.state = "live";
    const swapMs = this.env.now() - t0;
    this.swaps.push({ group: g.id, at: t0, steps: g.files.length, maxStepMs: Math.round(this.stepMs * 100) / 100, swapMs: Math.round(swapMs * 100) / 100 });
    console.info(`[packs] ${g.id} in: ${(g.gpuBytes / 1048576).toFixed(0)} MB more on the GPU, longest upload step ${this.stepMs.toFixed(1)} ms`);
  }

  /** Stop a group in flight: abort its download, free what it made; it starts over at the next resume. */
  private drop(g: Group) {
    const a = g.abort;
    g.abort = null;
    a?.abort();
    this.release(g);
    g.state = "pending";
    if (this.current === g) this.current = null;
  }

  /** Put the shipped textures back in a live group's slots and release the HD ones. */
  private rollback(g: Group) {
    for (const l of g.live) l.slot.set(l.base);
    for (const l of g.live) l.hd.dispose();
    g.live = [];
    g.gpuBytes = 0;
    g.state = "pending";
  }

  private release(g: Group) {
    for (const t of g.made) t?.dispose();
    g.made = [];
    g.steps = [];
    g.gpuBytes = 0;
  }
}

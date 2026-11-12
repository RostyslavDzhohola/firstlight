// HD art packs after arrival (#48, D-artpacks): the session's controller. After a hand-over (play
// resumed, the arrival's own downloads done) and a short delay, it works through the packs the tier
// takes (catalog.ts), one swap group at a time: download (verified), decode off the main thread, upload
// in slices, one per frame, while the shipped textures keep drawing, then rebind the group's textures
// in the same materials in one frame (no new programs) and release the shipped ones on the GPU.
//
// A loading screen (travel, a graphics change) pauses it: the download in flight is aborted, a group
// half uploaded is dropped. A tier that doesn't take a pack puts the shipped textures back (they upload
// again behind that loading screen's warm-up) and releases the HD ones. A failed download keeps the
// shipped textures, as does a failed decode, upload step or rebind (the whole group is dropped); each
// group gets two tries per session. No manifest (the packs aren't on this server) is the session's
// answer, said once; a manifest that fails to arrive is tried a few times. The env is injected (tests
// drive it by hand).

import type * as THREE from "three/webgpu";
import type { Tier } from "../quality.ts";
import { GPU_PACK_BUDGET_BYTES, packsFor, textureGpuBytes, wantedGroups, type PackChoice, type PackEntry, type PackId, type PackManifest } from "./catalog.ts";

/** Where a material (or a set of them) draws a texture from: rebinding it changes no program. */
export interface TextureSlot {
  readonly texture: THREE.Texture;
  set(t: THREE.Texture): void;
}

export interface ArtPacksEnv {
  /**
   * The pack manifest. Null: there is none (404, not a manifest), final for the session; a rejection
   * is a failure that may pass (network, 5xx), tried again a bounded number of times.
   */
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
  stepCount: number;
  live: Live[];
  /** HD minus shipped GPU bytes once live (or while in flight). */
  gpuBytes: number;
  abort: AbortController | null;
}

export interface SwapRecord {
  group: string;
  /** When its first upload step ran (the env's clock, ms). */
  uploadAt: number;
  /** When it was swapped in. */
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

/**
 * Free an HD texture this controller made: its GPU side, and a decoded 2D image still held (an
 * ImageBitmap, 16–64 MB outside the JS heap; uploaded ones have only their size left). Every path that
 * gives an HD texture up comes through here. Never for a shipped texture: its CPU copy stays.
 */
export function freeTexture(t: THREE.Texture | undefined) {
  if (!t) return;
  const img = t.image as { close?: () => void } | null | undefined;
  if (typeof img?.close === "function") {
    img.close();
    const { width, height } = t.image as { width?: number; height?: number };
    t.image = { width, height };
  }
  t.dispose();
}

/** The manifest as far as this session knows it. */
type ManifestState =
  | { kind: "unknown" }
  | { kind: "asking"; p: Promise<PackManifest | null> }
  | { kind: "waiting"; cancel: () => void }
  | { kind: "known"; manifest: PackManifest | null };

export class ArtPacks {
  /** After a hand-over, wait this long before the first download (the arrival's late downloads, the first frames of play). */
  static START_DELAY_MS = 3000;
  /** A manifest that failed to arrive is asked again after this (doubling each time), up to MANIFEST_TRIES in a session. */
  static MANIFEST_RETRY_MS = 15_000;
  static MANIFEST_TRIES = 3;

  private tier: Tier | null = null;
  private packs: PackId[] = [];
  private manifest: ManifestState = { kind: "unknown" };
  private manifestTries = 0;
  private readonly groups = new Map<string, Group>();
  private running = false;
  private pumping = 0;
  private cancelStart: (() => void) | null = null;
  /** The resume() waiting to start (cleared when it starts or is paused). */
  private startToken: object | null = null;
  private current: Group | null = null;
  private stepMs = 0;
  private uploadAt = 0;
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

  /**
   * Play resumed after a loading screen: start on whatever the tier takes and isn't in yet, after the
   * delay and once `after` settles (the arrival's own downloads still running in play: a site asset
   * past its deadline).
   */
  resume(opts: { delayMs?: number; after?: Promise<unknown> } = {}) {
    for (const g of this.groups.values()) g.cooling = false;
    if (this.running || this.startToken || !this.packs.length) return;
    const token = {};
    this.startToken = token;
    const go = () => {
      if (this.startToken !== token) return; // paused meanwhile
      this.startToken = null;
      this.running = true;
      void this.pump();
    };
    let cancel = this.env.later(() => {
      if (!opts.after) return go();
      cancel = () => undefined;
      void opts.after.then(go, go);
    }, opts.delayMs ?? ArtPacks.START_DELAY_MS);
    this.cancelStart = () => {
      cancel();
      if (this.startToken === token) this.startToken = null;
    };
  }

  /** A loading screen: stop downloading and uploading (the arrival's own downloads come first). */
  pause() {
    this.cancelStart?.();
    this.cancelStart = null;
    this.running = false;
    if (this.manifest.kind === "waiting") {
      this.manifest.cancel(); // the next resume asks (the try count stays)
      this.manifest = { kind: "unknown" };
    }
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
      if (!this.uploadAt) this.uploadAt = t0;
      try {
        step();
      } catch (e) {
        this.failTry(g, "didn't upload", e); // nothing of it is bound: the shipped textures stay
        return;
      }
      this.stepMs = Math.max(this.stepMs, this.env.now() - t0);
      return;
    }
    try {
      this.swap(g);
    } catch (e) {
      this.failTry(g, "didn't swap in", e);
      return;
    }
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
      busy: !!this.current || !!this.startToken || this.pumping > 0 || this.manifest.kind === "waiting",
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
    this.pumping++;
    try {
      const manifest = await this.askManifest();
      if (!manifest || !this.running || this.current) return;
      this.next(manifest);
    } finally {
      this.pumping--;
    }
  }

  /** The manifest, once per session: null while there is none (yet). */
  private async askManifest(): Promise<PackManifest | null> {
    const m = this.manifest;
    if (m.kind === "known") return m.manifest;
    if (m.kind === "waiting") return null; // a retry is on its timer
    if (m.kind === "asking") return m.p;
    this.manifestTries++;
    const p = this.env.manifest().then(
      (manifest) => {
        if (!manifest) console.info("[packs] no HD art packs on this server; keeping the shipped textures");
        this.manifest = { kind: "known", manifest };
        return manifest;
      },
      (e: unknown) => {
        const last = this.manifestTries >= ArtPacks.MANIFEST_TRIES;
        if (last) console.warn(`[packs] the pack manifest didn't load in ${this.manifestTries} tries; keeping the shipped textures this session`, e);
        else console.info("[packs] the pack manifest didn't load; trying again later", e);
        if (last) this.manifest = { kind: "known", manifest: null };
        else if (!this.running) this.manifest = { kind: "unknown" }; // the next resume asks
        else {
          const cancel = this.env.later(() => {
            this.manifest = { kind: "unknown" };
            void this.pump();
          }, ArtPacks.MANIFEST_RETRY_MS * 2 ** (this.manifestTries - 1));
          this.manifest = { kind: "waiting", cancel };
        }
        return null;
      },
    );
    this.manifest = { kind: "asking", p };
    return p;
  }

  private next(manifest: PackManifest) {
    for (const w of wantedGroups(manifest, this.packs)) {
      let g = this.groups.get(w.group);
      if (!g) {
        g = { id: w.group, pack: w.pack, files: w.files, state: "pending", tries: 0, cooling: false, bases: [], made: [], steps: [], stepCount: 0, live: [], gpuBytes: 0, abort: null };
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
    this.uploadAt = 0;
    const abort = (g.abort = new AbortController());
    const { signal } = abort;
    const files = g.files.map(async (f, i) => {
      const bytes = await this.env.download(f, signal);
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const t = await this.env.make(f, bytes, g.bases[i]!.base, signal);
      if (signal.aborted || g.state !== "loading" || g.abort !== abort) {
        freeTexture(t); // given up meanwhile: nothing is uploaded or bound
        throw signal.reason ?? new Error("aborted");
      }
      g.made[i] = t;
      return t;
    });
    Promise.all(files).then(
      (made) => {
        if (g.abort !== abort || g.state !== "loading") return;
        try {
          g.steps = made.flatMap((t) => this.env.uploadSteps(t));
        } catch (e) {
          this.failTry(g, "didn't upload", e);
          return;
        }
        g.state = "uploading";
        g.stepCount = g.steps.length;
      },
      (e: unknown) => {
        if (g.abort !== abort) return; // dropped (pause / tier): already cleaned up
        this.failTry(g, "didn't load", e);
      },
    );
  }

  /**
   * A try of `g` failed (download, decode, upload or rebind): abort what is still running, free all it
   * made, keep the shipped textures bound. Two tries a session; the next one after the next resume.
   */
  private failTry(g: Group, what: string, e: unknown) {
    g.tries++;
    console.warn(`[packs] ${g.id} ${what}${g.tries >= MAX_TRIES ? "; keeping the shipped textures for this session" : "; trying again after the next loading screen"}`, e);
    const a = g.abort;
    g.abort = null; // a file still on its way is freed when it lands
    a?.abort();
    this.release(g);
    g.state = g.tries >= MAX_TRIES ? "failed" : "pending";
    g.cooling = true;
    if (this.current === g) this.current = null;
    void this.pump();
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
    const live = g.bases.map((b, i) => ({ slot: b.slot, base: b.base, hd: g.made[i]! }));
    const bound: Live[] = [];
    try {
      for (const l of live) {
        l.slot.set(l.hd);
        bound.push(l);
      }
    } catch (e) {
      for (const l of bound) l.slot.set(l.base); // all or nothing: the shipped ones back where they were
      throw e;
    }
    g.live = live;
    for (const l of g.live) l.base.dispose(); // its CPU copy stays: a tier change can bind it again
    g.made = [];
    g.abort = null;
    g.state = "live";
    const swapMs = this.env.now() - t0;
    this.swaps.push({ group: g.id, uploadAt: this.uploadAt, at: t0, steps: g.stepCount, maxStepMs: Math.round(this.stepMs * 100) / 100, swapMs: Math.round(swapMs * 100) / 100 });
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
    for (const l of g.live) freeTexture(l.hd);
    g.live = [];
    g.gpuBytes = 0;
    g.state = "pending";
  }

  private release(g: Group) {
    for (const t of g.made) freeTexture(t);
    g.made = [];
    g.steps = [];
    g.gpuBytes = 0;
  }
}

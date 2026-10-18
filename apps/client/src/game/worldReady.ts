// When the arrival's world is built enough to hand over (D-load-6): every terrain chunk the streaming
// wants round the player (Planet.loadRadius: up to 520 m, past every tier's tree distance of 110–260 m,
// so the far hills and their trees are there on the first frame), then the grass round the camera
// filled in. Before, the loader went at 160 m with grass and the rest filling in during play. Bounded:
// a chunk that never comes (a worker error) hands over the world as it is after WORLD_READY_CAP_MS.
// Pure, so the predicate is unit-tested; Game.ts feeds it Planet.buildState().

/** The longest an arrival waits for the world before showing it as it is (ms). Was 15 s. */
export const WORLD_READY_CAP_MS = 30_000;

/** How far the world round the focus is built (Planet.buildState). */
export interface WorldBuild {
  /** Chunks the streaming wants round the focus, and how many of them are built. */
  chunks: number;
  loaded: number;
  /** Grass cells still to fill round the camera (GrassSystem.backlog). */
  grass: number;
}

export interface WorldReadiness {
  done: boolean;
  /** Gave up at the cap with chunks or grass missing. */
  timedOut: boolean;
  /** 0–1: chunks in out of wanted (most of the work), grass last. */
  frac: number;
  /** The loader line ("Building the world 42/96"). */
  text: string;
}

/** The chunks' share of the step's bar; the grass fills the rest. */
const CHUNKS_SHARE = 0.85;

export function worldReady(b: WorldBuild, elapsedMs: number, capMs = WORLD_READY_CAP_MS): WorldReadiness {
  const chunksIn = b.chunks <= 0 || b.loaded >= b.chunks;
  const built = chunksIn && b.grass <= 0;
  const timedOut = !built && elapsedMs >= capMs;
  const chunkFrac = b.chunks > 0 ? Math.min(1, b.loaded / b.chunks) : 1;
  // The grass backlog is only known once its chunks are in: its share fills as the backlog empties,
  // a little at a time (each update builds a few cells), never past what is done.
  const frac = built ? 1 : chunksIn ? CHUNKS_SHARE + (1 - CHUNKS_SHARE) * (1 - Math.min(1, b.grass / 40)) * 0.99 : CHUNKS_SHARE * chunkFrac;
  const text = chunksIn ? "Building the world: grass…" : `Building the world ${Math.min(b.loaded, b.chunks)}/${b.chunks}`;
  return { done: built || timedOut, timedOut, frac, text };
}

/**
 * After the warm-up, the grass gets this long to catch up (ms): the first-visit probe can raise the
 * tier, which refills the grass wider and denser than the build before it saw.
 */
export const WORLD_TOPUP_CAP_MS = 5_000;

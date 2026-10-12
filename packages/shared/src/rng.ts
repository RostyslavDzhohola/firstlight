// Deterministic hashing and random numbers shared by client and server.
// Only integer ops, + - * / and floor: identical results in every JS engine.

/** 32-bit integer hash of up to four integers (murmur-style finaliser). */
export function hash4(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (c | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (d | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash to a float in [0, 1). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  return hash4(a, b, c, d) / 4294967296;
}

/** Small fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

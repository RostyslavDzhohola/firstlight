// A bounded sliding-window counter (security pass, D-security-1…8). Memory stays bounded on every
// path: a key is moved to the back of the map each time it is hit, so the front holds the idlest
// keys and every call drops expired ones from there; past `maxKeys` live keys a new key is refused
// (counted as over its limit) instead of growing the map. Callers put a global limit in front so a
// flood of addresses can't fill the map cheaply.

export class WindowLimiter {
  max: number;
  windowMs: number;
  maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number, maxKeys = 10_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  private sweep(now: number): void {
    for (const [k, list] of this.hits) {
      if (now - list[list.length - 1]! < this.windowMs) break; // the rest were hit more recently
      this.hits.delete(k);
    }
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  /** Hits of `key` in the window. */
  count(key: string, now = Date.now()): number {
    this.sweep(now);
    return this.recent(key, now).length;
  }

  /** Would one more hit of `key` be allowed (nothing is recorded)? */
  allows(key: string, now = Date.now()): boolean {
    this.sweep(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) return false;
    return this.recent(key, now).length < this.max;
  }

  /** Record a hit of `key` if it is allowed; false (and nothing recorded) when it is over the limit. */
  take(key: string, now = Date.now()): boolean {
    if (!this.allows(key, now)) return false;
    this.add(key, now);
    return true;
  }

  /** Record a hit of `key` whatever the count (failed attempts). A new key beyond `maxKeys` is dropped. */
  add(key: string, now = Date.now()): void {
    this.sweep(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) return;
    const list = this.recent(key, now);
    list.push(now);
    if (list.length > this.max) list.splice(0, list.length - this.max); // only the newest `max` matter
    this.hits.delete(key);
    this.hits.set(key, list);
  }

  get size(): number {
    return this.hits.size;
  }

  clear(): void {
    this.hits.clear();
  }
}

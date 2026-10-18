// Funny lines at the bottom of the full loading screen, a new one every few seconds (D-load-5: a
// longer first load is fine if the game looks better; the loader keeps it fun). The first three are
// the owner's. Short (≤ 45 characters), playful, never mean, no real people, nothing that reads like
// an error, and no Easter-egg hints.

export const QUIPS: readonly string[] = [
  "Putting better graphics in…",
  "Looking for the meaning of life…",
  "Contemplating the universe…",
  "Waiting for first light…",
  "Making it worth the wait…",
  "Warming the shaders by the fire…",
  "Untangling the shadows…",
  "Rolling out the terrain, hills first…",
  "Placing every rock by hand…",
  "Adding one more tree. Okay, two…",
  "Asking the GPU nicely…",
  "Counting the stars. Lost count. Again…",
  "Nudging the planets into orbit…",
  "Sweeping the streets of Portus…",
  "Saving a spot on the wall of first names…",
  "Reminding the creeps to stay outside…",
  "Charging the portals in Portus…",
  "Polishing every fast-travel pad…",
  "Growing the grass in Clover Fields…",
  "Filling Glasswater Lake, one cup at a time…",
  "Herding the Woolbacks back into frame…",
  "Asking the Brightbits to hold still…",
  "Teaching the Sparkflies to fly straight…",
  "Feeding coins to the Cabinet Golem…",
  "Lighting the candles in Hollowmere…",
  "Waking the Hollow Court. Gently…",
  "Convincing the Dusk Wolves it's daytime…",
  "Rusting the Cinder Canyons to taste…",
  "Buffing the Chrome Spires…",
  "Awaiting sign-off from Meridian Oversight…",
];

/** How long each line stays up (ms). */
export const QUIP_MS = 3000;

/**
 * A loader line that reports a problem ("The server couldn't save just now. Rejoining shortly…",
 * reconnecting, a lost connection): no joke under it. The next normal line brings the quips back.
 */
export function reportsTrouble(text: string): boolean {
  return /\b(?:couldn['’]t|could not|can['’]t|cannot|reconnect\w*|rejoin\w*|disconnect\w*|lost|trouble|fail\w*|error)\b/i.test(text);
}

/**
 * A shuffled deck: every line once (the first one random), then a fresh shuffle that never starts
 * with the line just shown. `random` (0 ≤ r < 1) is injectable for tests.
 */
export function quipDeck<T>(lines: readonly T[], random: () => number = Math.random): { next(): T } {
  const all = [...lines];
  const pick = (n: number) => Math.min(n - 1, Math.floor(random() * n));
  let order: T[] = [];
  let shown: { line: T } | null = null;
  return {
    next(): T {
      if (order.length === 0) {
        order = [...all];
        for (let i = order.length - 1; i > 0; i--) {
          const j = pick(i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        // The seam between two shuffles: swap the repeat with any later line.
        if (shown && order.length > 1 && order[0] === shown.line) {
          const j = 1 + pick(order.length - 1);
          [order[0], order[j]] = [order[j]!, order[0]!];
        }
      }
      shown = { line: order.shift()! };
      return shown.line;
    },
  };
}

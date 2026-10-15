// The server's `huntTargets` (the tracked hunt's NPCs whose kill would count), held from the moment
// we join a room: the message comes once per change, and the SDK drops a message nobody listens to,
// so it can't wait for the mission pointer, which only starts once the world is built (Codex
// round 2). Game registers this right after joining; MissionPointer reads the latest.

export interface HuntTargets {
  /** Mission id ("" = the tracked mission isn't a hunt here). */
  id: string;
  npcs: ReadonlySet<string>;
}

interface MessageSource {
  onMessage(type: "huntTargets", cb: (m: { id: string; npcs: string[] }) => void): unknown;
}

let latest: HuntTargets | null = null;

/** Start listening on a freshly joined room (forgets the previous room's list). */
export function listenHuntTargets(room: MessageSource): void {
  latest = null;
  room.onMessage("huntTargets", (m) => {
    latest = { id: m.id, npcs: new Set(m.npcs) };
  });
}

/** The latest list for this room, or null (none yet, or an older server that never sends one). */
export function huntTargets(): HuntTargets | null {
  return latest;
}

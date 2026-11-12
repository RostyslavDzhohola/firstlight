// The event feed (D-ui-3): a few quiet lines under the minimap about the people around you: who
// arrived and left, who fell to whom, what you felled, and news of the hunt. This file is the pure
// part (the lines, their wording, how long they stay); ui/momentsView.ts draws it and
// game/MomentsClient.ts feeds it.

export type FeedKind = "join" | "leave" | "kill" | "death" | "hunt" | "info";

export interface FeedWho {
  name: string;
  /** An AI agent (PlayerState.agent, when the server has the field): gets the "AI" chip. */
  agent?: boolean;
  /** This is us: shown as "You". */
  me?: boolean;
}

/** A line is parts in order: plain text, or a name (bold, with its chip). */
export type FeedPart = string | FeedWho;

export interface FeedLine {
  id: number;
  kind: FeedKind;
  parts: FeedPart[];
  /** When it was added and when it goes (the model's clock). */
  at: number;
  until: number;
}

export const FEED_MAX = 4;
export const FEED_MS = 6500;
/** Hunt news stays longer: it is rarer and worth reading. */
export const FEED_HUNT_MS = 10_000;

const who = (w: FeedWho): FeedWho => (w.me ? { ...w, name: "You" } : w);

export const feedText = {
  joined: (w: FeedWho): FeedPart[] => [who(w), " arrived"],
  left: (w: FeedWho): FeedPart[] => [who(w), " left"],
  /** A player died: to another player, to a creature (`by` is its name), or to the world. */
  fell: (victim: FeedWho, by: FeedWho | string | null): FeedPart[] =>
    by === null || by === "" ? [who(victim), " fell"] : typeof by === "string" ? [who(victim), ` fell to ${by}`] : [who(by), " felled ", who(victim)],
  /** Our own kill of a creature, with what it paid. */
  felled: (npc: string, xp: number, coins: number): FeedPart[] => [`${npc} down${xp > 0 ? ` · +${xp} XP` : ""}${coins > 0 ? ` · +${coins} ◎` : ""}`],
  wonGleam: (w: FeedWho, gleam: string): FeedPart[] => [who(w), ` won ${gleam}`],
  openedVault: (w: FeedWho): FeedPart[] => [who(w), " opened the Gleam Vault"],
};

/** The line as plain text (aria, tests, the e2e hook). */
export function feedPlain(parts: readonly FeedPart[]): string {
  return parts.map((p) => (typeof p === "string" ? p : p.agent ? `${p.name} (AI)` : p.name)).join("");
}

/**
 * The lines on screen, newest last. `add` returns the new line; `tick` drops the ones whose time is
 * up and says whether anything changed (so the view writes the DOM only then). The same text twice
 * within a second is one line (a kill reported by two messages).
 */
export class FeedModel {
  private seq = 0;
  private items: FeedLine[] = [];

  get lines(): readonly FeedLine[] {
    return this.items;
  }

  add(kind: FeedKind, parts: FeedPart[], now: number, ms = kind === "hunt" ? FEED_HUNT_MS : FEED_MS): FeedLine | null {
    const text = feedPlain(parts);
    if (this.items.some((l) => now - l.at < 1000 && feedPlain(l.parts) === text)) return null;
    const line: FeedLine = { id: ++this.seq, kind, parts, at: now, until: now + ms };
    this.items.push(line);
    if (this.items.length > FEED_MAX) this.items = this.items.slice(-FEED_MAX);
    return line;
  }

  tick(now: number): boolean {
    const n = this.items.length;
    if (n && this.items.some((l) => l.until <= now)) this.items = this.items.filter((l) => l.until > now);
    return this.items.length !== n;
  }

  clear(): boolean {
    const had = this.items.length > 0;
    this.items = [];
    return had;
  }
}

// ------------------------------------------------------------------------------------- who is here

/**
 * Arrivals and departures from two snapshots of the room's players (id → name). The first snapshot
 * of a room is the people already there: nobody "arrived". Our own id never reports.
 */
export class Roster<T extends { name: string }> {
  private known: Map<string, T> | null = null;

  /** Forget the room (a new one starts with a silent first snapshot). */
  reset(): void {
    this.known = null;
  }

  diff(now: ReadonlyMap<string, T>, me: string): { joined: T[]; left: T[] } {
    const joined: T[] = [];
    const left: T[] = [];
    const prev = this.known;
    if (prev) {
      for (const [id, p] of now) if (id !== me && !prev.has(id)) joined.push(p);
      for (const [id, p] of prev) if (id !== me && !now.has(id)) left.push(p);
    }
    this.known = new Map(now);
    return { joined, left };
  }
}

// The spellbook as the client sees it: the server's private `you.spells` (aether, cooldowns, the
// ward), turned into what the HUD draws and what a key press may send. Pure (no DOM, no three):
// the HUD, the cast keys and the e2e hook all read the same view. Times are server clock (ms).
// A cast is shown at once (spent aether, cooldown started) and taken back if the server refuses it;
// casts in flight are kept by number on top of the server's last word.

import { AETHER, aetherAt, castBlock, SPELL_INDEX, SPELLS, spellUnlocked, type SpellDef, type SpellId, type SpellsYou } from "@firstlight/shared/content/spells";

export interface SpellSlotView {
  id: SpellId;
  name: string;
  keycap: string;
  /** Level that unlocks it; `locked` while the character is below it. */
  level: number;
  locked: boolean;
  /** Seconds of cooldown left (0 = none) and the share of the whole cooldown that is (1 → 0). */
  cooldown: number;
  cooldownFrac: number;
  /** Unlocked and off cooldown, but not enough aether. */
  short: boolean;
  /** A press would cast it. */
  ready: boolean;
  cost: number;
}

export interface SpellBarView {
  aether: number;
  max: number;
  slots: SpellSlotView[];
  /** The Glasswing Ward while it is up: shell HP left of its full HP, seconds left. */
  ward: { hp: number; max: number; left: number } | null;
}

/** What the HUD says when a press can't cast. */
export function blockText(s: SpellDef, why: "level" | "cooldown" | "aether"): string {
  if (why === "level") return `${s.name} unlocks at level ${s.level}`;
  if (why === "cooldown") return `${s.name} isn't ready yet`;
  return `Not enough aether for ${s.name}`;
}

/** The server's refusal of a cast, as the toast says it (null: nothing worth a toast). */
export function castDeniedText(reason: string, s: SpellDef | undefined): string | null {
  switch (reason) {
    case "safe zone": return "No spells in safe zones";
    case "protected": return "Arrival protection: spells ready in a moment";
    case "swimming": return "Can't cast while swimming";
    case "mounted": return "No spells from the saddle: E to get off";
    case "blocked": return s?.id === "wishfall" ? "No clear ground there for Wishfall" : "No room to Skipstep that way";
    case "locked": return s ? blockText(s, "level") : null;
    case "cooldown": return s ? blockText(s, "cooldown") : null;
    case "aether": return s ? blockText(s, "aether") : null;
    default: return null;
  }
}

const empty = (now: number): SpellsYou => ({ aether: AETHER.max, t: now, regenAt: 0, ready: SPELLS.map(() => 0) });

/** A cast that was sent and not answered yet. */
interface PendingCast {
  /** The number it was sent with (`cast.req`): the server's refusal and its next `you.spells.req` name it. */
  req: number;
  id: SpellId;
  /** Server clock (ms) when it was sent. */
  at: number;
}

/** A cast nobody answered (dropped by the server's rate limit, a lost connection) is shown this long. */
const PENDING_MS = 2000;

export class SpellBook {
  level = 1;
  /** The server's last word. */
  private base: SpellsYou | null = null;
  /**
   * Casts in flight, oldest first. What the HUD shows is `base` with these on top, so any number
   * of casts can be out at once and each answer takes back exactly its own (review 5: one rollback
   * snapshot let the second cast overwrite the first's).
   */
  private readonly pending: PendingCast[] = [];
  private seq = 0;
  /** `base` with the pending casts applied; rebuilt when either changes, not per frame. */
  private shown: SpellsYou | null = null;

  /**
   * A `you` from the server: it is the truth up to the cast it names (`req`: the last of our casts
   * it has dealt with). Later casts are still in flight and stay shown on top of it. A server that
   * doesn't number casts answers them all.
   */
  setYou(spells: SpellsYou | undefined, level: number) {
    this.level = level;
    if (!spells) return;
    this.base = spells;
    const handled = spells.req ?? Infinity;
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.req <= handled) this.pending.splice(i, 1);
    this.rebuild();
  }

  /** Has the server said anything about spells yet (older servers never do)? */
  get known(): boolean {
    return this.base !== null;
  }

  private rebuild() {
    let cur = this.base;
    for (const p of this.pending) {
      const index = SPELL_INDEX.get(p.id)!;
      const s = SPELLS[index]!;
      const from = cur ?? empty(p.at);
      const ready = [...from.ready];
      ready[index] = p.at + s.cooldownS * 1000;
      cur = { ...from, aether: Math.max(0, aetherAt(from, p.at) - s.cost), t: Math.max(from.t, p.at), regenAt: p.at + AETHER.regenDelayMs, ready };
    }
    this.shown = cur;
  }

  /** What to show at `now`: casts nobody answered in time are dropped first. */
  private state(now: number): SpellsYou | null {
    if (this.pending.length > 0 && now - this.pending[0]!.at > PENDING_MS) {
      while (this.pending.length > 0 && now - this.pending[0]!.at > PENDING_MS) this.pending.shift();
      this.rebuild();
    }
    return this.shown;
  }

  /** Why a press of `id` can't cast right now, or null. */
  block(id: SpellId, now: number): "level" | "cooldown" | "aether" | null {
    return castBlock(SPELLS[SPELL_INDEX.get(id)!]!, this.level, this.state(now), now);
  }

  /** A cast is being sent: show it now. Returns the number to send it with (`cast.req`). */
  predict(id: SpellId, now: number): number {
    this.state(now);
    const req = ++this.seq;
    this.pending.push({ req, id, at: now });
    this.rebuild();
    return req;
  }

  /**
   * The server refused a cast: take that prediction back (the others stay). `req` names the cast;
   * without it (a server that doesn't number them) it is the oldest one in flight, since answers
   * come in order. Returns the spell taken back, or null when that cast was answered already.
   */
  refused(now: number, req?: number): SpellId | null {
    this.state(now);
    const i = req === undefined ? 0 : this.pending.findIndex((p) => p.req === req);
    const p = i >= 0 ? this.pending[i] : undefined;
    if (!p) return null;
    this.pending.splice(i, 1);
    this.rebuild();
    return p.id;
  }

  view(now: number): SpellBarView {
    const you = this.state(now) ?? empty(now);
    const aether = aetherAt(you, now);
    const slots = SPELLS.map((s, i): SpellSlotView => {
      const locked = !spellUnlocked(s, this.level);
      const left = Math.max(0, ((you.ready[i] ?? 0) - now) / 1000);
      const short = !locked && left <= 0 && aether < s.cost;
      return {
        id: s.id, name: s.name, keycap: s.keycap, level: s.level, locked, cost: s.cost,
        cooldown: locked ? 0 : left,
        cooldownFrac: locked ? 0 : Math.min(1, left / s.cooldownS),
        short,
        ready: !locked && left <= 0 && !short,
      };
    });
    const w = you.ward && you.ward.until > now ? { hp: you.ward.hp, max: you.ward.max, left: (you.ward.until - now) / 1000 } : null;
    return { aether, max: AETHER.max, slots, ward: w };
  }
}

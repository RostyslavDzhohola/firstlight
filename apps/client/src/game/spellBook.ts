// The spellbook as the client sees it: the server's private `you.spells` (aether, cooldowns, the
// ward), turned into what the HUD draws and what a key press may send. Pure (no DOM, no three):
// the HUD, the cast keys and the e2e hook all read the same view. Times are server clock (ms).
// A cast is shown at once (spent aether, cooldown started) and taken back if the server refuses it.

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
    case "blocked": return "No room to Skipstep that way";
    case "locked": return s ? blockText(s, "level") : null;
    case "cooldown": return s ? blockText(s, "cooldown") : null;
    case "aether": return s ? blockText(s, "aether") : null;
    default: return null;
  }
}

const empty = (now: number): SpellsYou => ({ aether: AETHER.max, t: now, regenAt: 0, ready: SPELLS.map(() => 0) });

export class SpellBook {
  level = 1;
  private you: SpellsYou | null = null;
  /** The state before the last unanswered cast, to put back on a refusal. */
  private undo: { id: SpellId; you: SpellsYou | null; until: number } | null = null;

  /** A `you` from the server: it is the truth (and answers any cast in flight). */
  setYou(spells: SpellsYou | undefined, level: number) {
    this.level = level;
    if (!spells) return;
    this.you = spells;
    this.undo = null;
  }

  /** Has the server said anything about spells yet (older servers never do)? */
  get known(): boolean {
    return this.you !== null;
  }

  /** Why a press of `id` can't cast right now, or null. */
  block(id: SpellId, now: number): "level" | "cooldown" | "aether" | null {
    return castBlock(SPELLS[SPELL_INDEX.get(id)!]!, this.level, this.you, now);
  }

  /** A cast was sent: show it now. */
  predict(id: SpellId, now: number) {
    const s = SPELLS[SPELL_INDEX.get(id)!]!;
    const was = this.you;
    const cur = was ?? empty(now);
    const ready = [...cur.ready];
    ready[SPELL_INDEX.get(id)!] = now + s.cooldownS * 1000;
    this.undo = { id, you: was, until: now + 2000 };
    this.you = { ...cur, aether: Math.max(0, aetherAt(cur, now) - s.cost), t: now, regenAt: now + AETHER.regenDelayMs, ready };
  }

  /** The server refused a cast: take the prediction back (its own `you` follows if anything changed). */
  refused(now: number) {
    if (this.undo && now <= this.undo.until) this.you = this.undo.you;
    this.undo = null;
  }

  view(now: number): SpellBarView {
    const you = this.you ?? empty(now);
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

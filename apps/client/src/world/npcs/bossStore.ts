// Boss state for the HUD lane: a tiny store plus window.__boss and `fl:boss` DOM events.
// No hints: only what the screen would show anyway (name, HP, phase) and voice lines for subtitles.

import type { BossEventMsg } from "@firstlight/shared/content/npcs";

export interface BossHud {
  id: string;
  boss: string;
  name: string;
  hp: number;
  maxHp: number;
  phase: number;
  /** Players counted for the HP scaling. */
  engaged: number;
  /** Weak window open (Moored / Asset Freeze / rib cage). */
  weak: boolean;
  /** The local player is at the lair (show the bar). */
  visible: boolean;
  /** Last voice line for subtitles (`NAME: line`, ≥ 3.5 s on screen). */
  voice: { name: string; line: string; at: number } | null;
  defeatedAt: number;
}

type Listener = (s: BossHud | null) => void;
let current: BossHud | null = null;
const listeners = new Set<Listener>();

export const bossStore = {
  get(): BossHud | null {
    return current;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(current);
    return () => listeners.delete(fn);
  },
  set(next: BossHud | null) {
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    (window as unknown as { __boss: BossHud | null }).__boss = next;
    if (changed) for (const l of listeners) l(next);
  },
  /** Forward a raw boss event to the page (HUD subtitles, music cues). */
  event(msg: BossEventMsg) {
    window.dispatchEvent(new CustomEvent("fl:boss", { detail: msg }));
  },
};

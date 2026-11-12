// The first hint for spells (D-ui-5): one toast, the first time the player stands outside a safe
// zone with Skipstep ready, saying which key casts it. The tutorial never mentions spells (it runs
// inside Portus, where they are holstered), so this is where a new player learns the book exists.
// Once per browser (`fl.hint.spells`); a player who casts anything first never sees it. Pure: the
// store is injected, MomentsClient shows the toast.

const KEY = "fl.hint.spells";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface SpellHintNow {
  /** The server's SAFE flag on us (spells are refused in safe zones). */
  safe: boolean;
  /** Skipstep would cast on a press (unlocked, off cooldown, enough aether). */
  ready: boolean;
  /** The world is on screen and ours to play: no menu, panel, photo mode or death screen. */
  playing: boolean;
  /** The tutorial's card is up: it has the player's attention. */
  tutorial: boolean;
}

export class SpellHint {
  private done: boolean;
  private readonly store: Store | null;

  constructor(store: Store | null = defaultStore()) {
    this.store = store;
    let seen = false;
    try {
      seen = store?.getItem(KEY) === "1";
    } catch {
      /* private mode: the hint may show once per page */
    }
    this.done = seen;
  }

  get seen(): boolean {
    return this.done;
  }

  private mark() {
    this.done = true;
    try {
      this.store?.setItem(KEY, "1");
    } catch {
      /* not remembered: once per page then */
    }
  }

  /** The player cast a spell: they know the keys. */
  cast(): void {
    if (!this.done) this.mark();
  }

  /** True exactly once: the moment to show the hint. */
  due(now: SpellHintNow): boolean {
    if (this.done || now.safe || !now.ready || !now.playing || now.tutorial) return false;
    this.mark();
    return true;
  }
}

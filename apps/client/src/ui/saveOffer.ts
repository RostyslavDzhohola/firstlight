// When the game offers saving (HANDOFF 5c, the owner's final decision). Guests play with one click and
// are asked for an email only to save their progress, at natural moments that never block play:
//   - a "Progress not saved · Esc → Save progress" toast, once per session, after the first level-up
//     to 2+ (the tutorial pays level 2 within its first minute; the toast waits until its tips and
//     end card are gone, and while a menu or the death screen is up);
//   - a Save progress row in the Esc menu, a line on the death screen, and the home page's "Save your
//     progress" (home/home.ts, through `openSaveProgress()`; logging out lands there).
// The save card itself opens only with the mouse free. Saved players never see any of it.
// Pure (unit-tested; no DOM).

/** The server emails a code for a new address only from a player who reached this level (D34). */
export const SAVE_MIN_LEVEL = 2;

/**
 * "guest": a real guest session, which can be saved. "saved": an account with an email. "none":
 * nothing to save here (a `?devguest` token, an `?offline`/`?bench` run, or no session yet).
 */
export type SaveStatus = "guest" | "saved" | "none";

/** `guest`: the session's or token's guest flag, null when there is no session. */
export function saveStatusOf(s: { devGuest: boolean; offline: boolean; guest: boolean | null }): SaveStatus {
  if (s.devGuest || s.offline || s.guest === null) return "none";
  return s.guest ? "guest" : "saved";
}

/** Whether a save prompt (toast, menu row, death line, logged-out button) may show at all. */
export function offersSave(status: SaveStatus): boolean {
  return status === "guest";
}

/** Whether the server would email a code yet (the Esc menu row is enabled from here). */
export function saveReady(bestLevel: number): boolean {
  return bestLevel >= SAVE_MIN_LEVEL;
}

/** The save card needs the mouse: it never opens while the game holds the pointer. */
export function mayOpenSaveCard(s: { pointerLocked: boolean }): boolean {
  return !s.pointerLocked;
}

/** How long after the level-up (counted while nothing holds it) the toast shows: after the level-up's own toasts. */
export const NUDGE_DELAY_MS = 1500;

/**
 * The "Progress not saved" toast: once per session, after the first level-up to 2+. It's due
 * NUDGE_DELAY_MS of unheld time after the level-up; the caller then checks eligibility (async) and
 * rechecks `held` right before showing (`offerNudge`), so an Esc, a death or a travel during either
 * wait keeps it pending instead of showing it behind a menu and using up the session's one toast.
 */
export class SaveNudge {
  private pending = false;
  private shown: boolean;
  private checking = false;
  private dueAt = -1;
  private readonly delayMs: number;
  /** Highest level seen this session (a rebirth drops to 1; the server still counts the best). */
  best = 0;

  /** `shownThisSession`: the toast already showed in this tab (a reload doesn't nag again). */
  constructor(shownThisSession = false, delayMs = NUDGE_DELAY_MS) {
    this.shown = shownThisSession;
    this.delayMs = delayMs;
  }

  /** Every `you` update: a rise to level 2 or more asks for the toast. Joining at level 5 isn't a rise. */
  levelUp(level: number, prevLevel: number): void {
    this.best = Math.max(this.best, level);
    if (level > prevLevel && level >= SAVE_MIN_LEVEL && !this.shown) this.pending = true;
  }

  /**
   * Once per frame. `held` while the tutorial is up, a menu has the mouse, the player is dead or
   * travelling: the wait starts over once free. True on the frame the caller should check (then
   * `shownNow()`, `later()` or `never()`; `offerNudge` does that).
   */
  poll(held: boolean, now: number): boolean {
    if (!this.pending || this.shown || this.checking) return false;
    if (held) {
      this.dueAt = -1;
      return false;
    }
    if (this.dueAt < 0) this.dueAt = now + this.delayMs;
    if (now < this.dueAt) return false;
    this.checking = true;
    return true;
  }

  /** The toast went up: the session's one. */
  shownNow(): void {
    this.checking = this.pending = false;
    this.shown = true;
  }

  /** It couldn't show just now (held again, or the check failed): stays pending. */
  later(): void {
    this.checking = false;
    this.dueAt = -1;
  }

  /** Not a guest (saved, a dev token, offline): nothing this session. */
  never(): void {
    this.checking = this.pending = false;
    this.shown = true;
  }
}

/** The caller's half of a due toast: eligibility first, then `held` again right before it shows. */
export async function offerNudge(n: SaveNudge, io: { status(): Promise<SaveStatus>; held(): boolean; show(): void }): Promise<void> {
  let status: SaveStatus;
  try {
    status = await io.status();
  } catch {
    return n.later();
  }
  if (!offersSave(status)) return n.never();
  if (io.held()) return n.later();
  n.shownNow();
  io.show();
}

/**
 * What the card says when a code couldn't be sent (server: `mailError` in better-auth.ts).
 * "unavailable": the server can't send any code right now (e.g. the sending domain isn't verified).
 * "busy": a budget or the provider's quota; "rejected": that address; "retry": anything else.
 */
export type SendFailure = "unavailable" | "busy" | "rejected" | "retry";

export function sendCodeFailure(e: { status?: number; code?: string }): SendFailure {
  if (e.code === "SAVING_UNAVAILABLE") return "unavailable";
  if (e.code === "SAVING_BUSY" || e.status === 429) return "busy";
  if (e.code === "EMAIL_REJECTED" || e.status === 400) return "rejected";
  if (e.status === 503) return "unavailable";
  return "retry";
}

/** The save card's steps (ui/account.ts). */
export type SaveStep = "email" | "code" | "saved" | "busy" | "unavailable" | "locked";

/**
 * The card's first step after its checks: say "unavailable" or "not yet" up front, before the player
 * types an address. `saveReady` is the server's answer (undefined from an older server: try).
 */
export function firstSaveStep(c: { saving: "ok" | "busy" | "unavailable"; saveReady: boolean | undefined }): SaveStep {
  if (c.saving === "unavailable") return "unavailable";
  if (c.saving === "busy") return "busy";
  if (c.saveReady === false) return "locked";
  return "email";
}

/** The six digits in a pasted text ("123456", "123 456", "Your FIRSTLIGHT code is 123456."). */
export function codeFromText(t: string): string {
  const run = t.match(/(?<!\d)\d{3}[\s-]?\d{3}(?!\d)/)?.[0] ?? t;
  return run.replace(/\D/g, "").slice(0, 6);
}

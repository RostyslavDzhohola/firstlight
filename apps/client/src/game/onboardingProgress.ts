// Only completed client tips persist. Dummy hits, XP and completion remain server-owned.
import { OnboardingSteps, STEPS } from "./onboardingSteps.ts";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export class OnboardingProgress {
  readonly steps = new OnboardingSteps();
  private readonly key: string | null;
  private ended = false;
  expanded = false;

  constructor(userId: string, private readonly store: Store | null = defaultStore()) {
    this.key = userId ? `fl.onboarding.v1:${encodeURIComponent(userId)}` : null;
    try { this.expanded = !!this.key && store?.getItem(`${this.key}:expanded`) === "true"; } catch { /* unavailable storage */ }
    try {
      const raw = this.key ? store?.getItem(this.key) : null;
      const saved = raw ? JSON.parse(raw) : null;
      if (saved?.v !== 1 || !Array.isArray(saved.done)) return;
      for (const step of STEPS) if (step.id !== "attack" && saved.done.includes(step.id)) this.steps.complete(step.id);
    } catch { /* unavailable or corrupt storage: continue with in-memory tips */ }
  }

  save() {
    if (!this.key || this.ended) return;
    const done = STEPS.filter((s) => s.id !== "attack" && this.steps.isDone(s.id)).map((s) => s.id);
    try { this.store?.setItem(this.key, JSON.stringify({ v: 1, done })); } catch { /* private mode / quota */ }
  }

  /** A server done/skipped response, including an authoritative Portus state without onboarding. */
  end() {
    if (this.ended) return;
    this.ended = true;
    try { if (this.key) this.store?.removeItem(this.key); } catch { /* unavailable storage */ }
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    try { if (this.key) this.store?.setItem(`${this.key}:expanded`, String(expanded)); } catch { /* private mode / quota */ }
  }
}

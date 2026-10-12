// Onboarding HUD (verdict: Entry A's layout, kit markup in src/ui/README.md "Onboarding"): the
// compact current-step card, slim rail and expandable checklist, plus a world callout. Plain DOM
// (D25); per-frame calls touch the DOM only when a value changes.

import "./styles/kit.css";
import "./onboarding.css";
import { STEPS, type OnboardingSteps, type StepDef } from "../game/onboardingSteps.ts";
import { button, el, icon } from "./dom.ts";

function keys(parent: HTMLElement, list: readonly string[], cls = "fl-keys"): HTMLElement {
  const wrap = el("span", cls, parent);
  for (const k of list) {
    if (k === "+") el("span", "fl-onb__plus", wrap, "+");
    else el("span", `fl-key${k.length > 2 ? " fl-key--wide" : ""}`, wrap, k);
  }
  return wrap;
}

/** "Hold **Shift** while…" → text with <b> runs. */
function rich(parent: HTMLElement, text: string) {
  text.split("**").forEach((part, i) => {
    if (i % 2) el("b", "", parent, part);
    else if (part) parent.append(part);
  });
}

export class OnboardingHud {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly title: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly railText: HTMLElement;
  private readonly segs: HTMLElement[] = [];
  private card: HTMLElement;
  private barFill: HTMLElement | null = null;
  private barText: HTMLElement | null = null;
  private readonly callout: HTMLElement;
  private readonly calloutText: HTMLElement;
  private readonly calloutSub: HTMLElement;
  private readonly skipNote: HTMLElement;
  private readonly repoUrl: string | null;
  private readonly checklist: HTMLDetailsElement;
  private readonly onExpanded?: (expanded: boolean) => void;
  private last = { state: "", step: "", bar: "", callout: "", calloutText: "", paid: false };

  /** `repoUrl`: Star/Fork links on the last card (only once the repo is public). */
  constructor(parent: HTMLElement, onSkip: () => void, repoUrl: string | null = null, preference?: { expanded: boolean; onExpanded: (expanded: boolean) => void }) {
    this.repoUrl = repoUrl;
    this.onExpanded = preference?.onExpanded;
    this.root = el("div", "fl-onb fl-onb--compact fl-ui", parent);
    this.root.dataset.hud = "";
    const widget = el("div", "fl-onb__widget", this.root);
    this.checklist = el("details", "fl-onb__list fl-holo", widget);
    this.list = this.checklist;
    this.list.setAttribute("aria-label", "Tutorial");
    const summary = el("summary", "fl-onb__toggle", this.list);
    summary.title = "Show or hide the tutorial checklist (T)";
    this.title = el("span", "", summary, "Tutorial checklist");
    keys(summary, ["T"]);
    this.checklist.open = preference?.expanded ?? false;
    this.checklist.addEventListener("toggle", () => this.onExpanded?.(this.checklist.open));
    for (const s of STEPS) {
      const row = el("div", "fl-onb__st", this.list);
      el("i", "", row);
      row.append(s.label);
      keys(row, s.keys);
      this.rows.push(row);
    }
    const skip = el("div", "fl-onb__skip", this.list);
    const b = button("Skip tutorial", "fl-btn fl-btn--sm", skip, onSkip);
    b.title = "No more XP and no Spark medal";
    this.skipNote = el("small", "", skip, "Esc → Skip tutorial. Skipping pays nothing more.");

    const rail = el("div", "fl-onb__rail", widget);
    rail.setAttribute("role", "progressbar");
    rail.setAttribute("aria-label", "Tutorial progress");
    rail.setAttribute("aria-valuemin", "0");
    rail.setAttribute("aria-valuemax", String(STEPS.length));
    this.railText = el("span", "fl-onb__rail-t", rail);
    const segs = el("div", "fl-onb__segs", rail);
    for (let i = 0; i < STEPS.length; i++) this.segs.push(el("i", "", segs));

    this.card = el("section", "fl-onb__step fl-holo fl-corners", widget);
    this.card.setAttribute("aria-live", "polite");

    this.callout = el("div", "fl-callout", this.root);
    this.callout.hidden = true;
    el("div", "fl-callout__line", this.callout);
    el("div", "fl-callout__dot", this.callout);
    const box = el("div", "fl-callout__box fl-holo", this.callout);
    this.calloutText = el("span", "", box);
    this.calloutSub = el("small", "", box);
  }

  /** Checklist, rail and card from the step machine (cheap to call every frame). `paid`: the server has paid the dummies. */
  render(steps: OnboardingSteps, paid = false) {
    if (paid !== this.last.paid) {
      this.last.paid = paid;
      this.skipNote.textContent = paid ? "XP and the Spark medal are yours; the rest is tips." : "Esc → Skip tutorial. Skipping pays nothing more.";
    }
    const cur = steps.current;
    const state = STEPS.map((s) => (steps.isDone(s.id) ? "d" : s === cur ? "n" : "-")).join("");
    if (state !== this.last.state) {
      this.last.state = state;
      const n = steps.doneCount;
      this.title.textContent = `Tutorial checklist · ${n} / ${STEPS.length}`;
      this.root.querySelector(".fl-onb__rail")?.setAttribute("aria-valuenow", String(n));
      STEPS.forEach((s, i) => {
        const done = steps.isDone(s.id);
        this.rows[i]!.className = `fl-onb__st${done ? " is-done" : s === cur ? " is-now" : ""}${s.optional ? " is-opt" : ""}`;
        this.segs[i]!.className = done ? "is-done" : s === cur ? "is-now" : "";
      });
      this.railText.replaceChildren("Step ");
      el("b", "", this.railText, String(cur ? STEPS.indexOf(cur) + 1 : STEPS.length));
      this.railText.append(` of ${STEPS.length}`);
    }
    const stepKey = cur ? `${cur.id}>${steps.next?.id ?? ""}` : "";
    if (stepKey !== this.last.step) {
      this.last.step = stepKey;
      this.last.bar = "";
      if (cur) this.buildCard(cur);
    }
    if (cur?.bar && this.barFill && this.barText) {
      const text = steps.progressText(cur.id);
      if (text !== this.last.bar) {
        this.last.bar = text;
        this.barFill.style.setProperty("--fill", steps.fraction(cur.id).toFixed(3));
        this.barText.textContent = text;
      }
    }
  }

  /** T while playing, or the native details summary when the mouse is free. */
  toggleChecklist() {
    this.checklist.open = !this.checklist.open;
    this.onExpanded?.(this.checklist.open);
  }

  private buildCard(s: StepDef) {
    // A fresh element per step, so the card's rise-in plays again.
    const c = el("section", "fl-onb__step fl-holo fl-corners");
    c.setAttribute("aria-live", "polite");
    this.card.replaceWith(c);
    this.card = c;
    el("span", "fl-onb__step-k", c, `First minute · ${STEPS.indexOf(s) + 1} / ${STEPS.length}`);
    el("h2", "", c, s.heading);
    keys(c, s.cardKeys, "fl-onb__keys");
    rich(el("p", "", c), s.text);
    this.barFill = this.barText = null;
    if (s.bar) {
      const hold = el("div", "fl-onb__hold", c);
      const bar = el("span", "fl-bar", hold);
      this.barFill = el("i", "", bar);
      this.barFill.style.setProperty("--fill", "0");
      this.barText = el("span", "num", hold);
    }
    if (s.id === "portal" && this.repoUrl) this.repoLinks(c, this.repoUrl);
  }

  private repoLinks(parent: HTMLElement, repoUrl: string) {
    const row = el("div", "fl-onb__done", parent);
    const star = el("a", "fl-btn fl-btn--sm", row);
    icon("star", "", star);
    star.append("Star on GitHub");
    star.href = repoUrl;
    const fork = el("a", "fl-btn fl-btn--sm", row);
    icon("fork", "", fork);
    fork.append("Fork");
    fork.href = `${repoUrl}/fork`;
    for (const a of [star, fork]) {
      a.target = "_blank";
      a.rel = "noopener";
    }
  }

  /** A world callout at screen (x, y) with a title and a line under it, or hidden (x = null). */
  setCallout(x: number | null, y = 0, title = "", sub = "") {
    const key = x === null ? "" : `${Math.round(x)},${Math.round(y)}`;
    if (key !== this.last.callout) {
      this.last.callout = key;
      this.callout.hidden = x === null;
      if (x !== null) {
        this.callout.style.setProperty("--x", `${Math.round(x)}px`);
        this.callout.style.setProperty("--y", `${Math.round(y)}px`);
      }
    }
    const text = `${title}\u0001${sub}`;
    if (text !== this.last.calloutText) {
      this.last.calloutText = text;
      this.calloutText.textContent = title;
      this.calloutSub.textContent = sub;
    }
  }

  /** The end card: XP, the medal, and the Star/Fork links once the repo is public. */
  showDone(xp: number) {
    this.list.hidden = true;
    this.callout.hidden = true;
    this.root.querySelector(".fl-onb__rail")?.remove();
    const c = this.card;
    c.replaceChildren();
    const k = el("span", "fl-onb__step-k", c, "Tutorial complete · ");
    el("b", "", k, `+${xp} XP`);
    el("h2", "", c, "You're ready");
    rich(el("p", "", c), "The **Spark** medal is yours: wear its title from the journal (**J**). Your inventory is on **I**. The portals around the plaza lead to the three planets.");
    if (this.repoUrl) this.repoLinks(c, this.repoUrl);
  }

  dispose() {
    this.root.remove();
  }
}

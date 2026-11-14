// Onboarding HUD (verdict: Entry A's layout, kit markup in src/ui/README.md "Onboarding"): the
// compact current-step card, slim rail and expandable checklist. Where a step (or the end card) points
// somewhere, the way is an arrow and distance inside the card itself, with the same target on the
// compass (#68: one place, not a second box). Plain DOM (D25); per-frame calls touch the DOM only
// when a value changes.

import "./styles/kit.css";
import "./onboarding.css";
import { STEPS, type OnboardingSteps, type StepDef } from "../game/onboardingSteps.ts";
import { button, el, icon } from "./dom.ts";
import { CONFIRM_MS, ConfirmClick } from "./saveOffer.ts";

/** Under the Skip button before the dummies pay: what skipping costs, the save lock included (#32). */
const SKIP_NOTE = "Esc → Skip tutorial. Skipping pays nothing more; saving unlocks at level 2.";

function keys(parent: HTMLElement, list: readonly string[], cls = "fl-keys"): HTMLElement {
  const wrap = el("span", cls, parent);
  for (const k of list) {
    if (k === "+") el("span", "fl-onb__plus", wrap, "+");
    else el("span", `fl-key${k.length > 2 ? " fl-key--wide" : ""}`, wrap, k);
  }
  return wrap;
}

/** The way to something, for the card's arrow row: what, its bearing from the camera's heading (degrees, clockwise), metres. */
export interface CardWay {
  label: string;
  deg: number;
  metres: number;
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
  private readonly widget: HTMLElement;
  /** The card's way row (arrow, label, metres), rebuilt with the card. */
  private way: { root: HTMLElement; arrow: HTMLElement; label: HTMLElement; metres: HTMLElement } | null = null;
  private readonly onResize = () => this.revealCurrent();
  /** Any later change in the panel's size (a card growing, fonts arriving) re-reveals the current row. */
  private readonly panelObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.revealCurrent());
  private readonly skipNote: HTMLElement;
  private readonly repoUrl: string | null;
  private readonly checklist: HTMLDetailsElement;
  private readonly onExpanded?: (expanded: boolean) => void;
  private last = { state: "", step: "", bar: "", way: "", paid: false };

  /** `repoUrl`: Star/Fork links on the last card (only once the repo is public). */
  constructor(parent: HTMLElement, onSkip: () => void, repoUrl: string | null = null, preference?: { expanded: boolean; onExpanded: (expanded: boolean) => void }) {
    this.repoUrl = repoUrl;
    this.onExpanded = preference?.onExpanded;
    this.root = el("div", "fl-onb fl-onb--compact fl-ui", parent);
    this.root.dataset.hud = "";
    const widget = el("div", "fl-onb__widget", this.root);
    this.widget = widget;
    addEventListener("resize", this.onResize);

    this.checklist = el("details", "fl-onb__list fl-holo", widget);
    this.list = this.checklist;
    this.list.setAttribute("aria-label", "Tutorial");
    const summary = el("summary", "fl-onb__toggle", this.list);
    summary.title = "Show or hide the tutorial checklist (T)";
    this.title = el("span", "", summary, "Tutorial checklist");
    keys(summary, ["T"]);
    this.checklist.open = preference?.expanded ?? false;
    // The list shrinks when the card above it grows (the widget itself stops at its max height).
    this.panelObserver?.observe(widget);
    this.panelObserver?.observe(this.checklist);
    this.checklist.addEventListener("toggle", () => {
      this.onExpanded?.(this.checklist.open);
      this.revealCurrent();
    });
    for (const s of STEPS) {
      const row = el("div", "fl-onb__st", this.list);
      el("i", "", row);
      row.append(s.label);
      keys(row, s.keys);
      this.rows.push(row);
    }
    const skip = el("div", "fl-onb__skip", this.list);
    // Before the dummies pay out, skipping costs XP and puts off saving: a second click confirms (#32).
    const confirm = new ConfirmClick();
    const b = button("Skip tutorial", "fl-btn fl-btn--sm", skip, () => {
      if (this.last.paid || confirm.click(performance.now())) return onSkip();
      b.textContent = "Click again to skip";
      this.skipNote.textContent = "Skipping pays nothing more, and saving waits until level 2. Click again to skip.";
      setTimeout(() => {
        b.textContent = "Skip tutorial";
        if (!this.last.paid) this.skipNote.textContent = SKIP_NOTE;
      }, CONFIRM_MS);
    });
    b.title = "No more XP and no Spark medal; saving waits until level 2";
    this.skipNote = el("small", "", skip, SKIP_NOTE);

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
  }

  /** Checklist, rail and card from the step machine (cheap to call every frame). `paid`: the server has paid the dummies. */
  render(steps: OnboardingSteps, paid = false) {
    if (paid !== this.last.paid) {
      this.last.paid = paid;
      this.skipNote.textContent = paid ? "XP and the Spark medal are yours; the rest is tips." : SKIP_NOTE;
    }
    let reveal = false;
    const cur = steps.current;
    const state = STEPS.map((s) => (steps.isDone(s.id) ? "d" : s === cur ? "n" : "-")).join("");
    if (state !== this.last.state) {
      this.last.state = state;
      const n = steps.doneCount;
      this.title.textContent = `Tutorial checklist · ${n} / ${STEPS.length}`;
      this.root.querySelector(".fl-onb__rail")?.setAttribute("aria-valuenow", String(n));
      STEPS.forEach((s, i) => {
        const done = steps.isDone(s.id);
        // A tip that moved on by itself isn't ticked: the player didn't do it.
        const moved = done && steps.movedOn(s.id);
        this.rows[i]!.className = `fl-onb__st${moved ? " is-moved" : done ? " is-done" : s === cur ? " is-now" : ""}${s.optional ? " is-opt" : ""}`;
        this.segs[i]!.className = done ? "is-done" : s === cur ? "is-now" : "";
      });
      reveal = true;
      this.railText.replaceChildren("Step ");
      el("b", "", this.railText, String(cur ? STEPS.indexOf(cur) + 1 : STEPS.length));
      this.railText.append(` of ${STEPS.length}`);
    }
    const stepKey = cur ? `${cur.id}>${steps.next?.id ?? ""}` : "";
    if (stepKey !== this.last.step) {
      this.last.step = stepKey;
      this.last.bar = "";
      reveal = true;
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
    // Once the new card is complete (bar text included): a taller card leaves the list less room.
    if (reveal) this.revealCurrent();
  }

  /** On a short screen the open checklist scrolls inside the widget, and while playing the mouse
   *  can't scroll it (the pointer is locked; unlocking opens the pause menu): keep the current step in view. */
  private revealCurrent() {
    if (!this.checklist.open) return;
    const row = this.rows.find((r) => r.classList.contains("is-now"));
    if (!row) return;
    // Scroll the list itself (scrollIntoView would also scroll the panel and push the card's heading out).
    const list = this.checklist;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
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
    this.way = null;
    this.last.way = "";
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

  /**
   * The way to where this card (or the end card) wants you: an arrow turned by the bearing (up =
   * straight ahead), the place's name and its distance, inside the card; null hides it. The same
   * target is on the compass, so turning until the arrow points up centres it there too.
   */
  setWay(way: CardWay | null) {
    if (!way) {
      if (this.way) {
        this.way.root.remove();
        this.way = null;
        this.last.way = "";
      }
      return;
    }
    if (!this.way) {
      const root = el("div", "fl-onb__way", this.card);
      root.dataset.e2e = "onboarding-way";
      const arrow = el("i", "fl-onb__arrow", root);
      const label = el("b", "", root);
      const metres = el("span", "num", root);
      this.way = { root, arrow, label, metres };
    }
    // Rounded so the DOM changes a few times a second at most: 5° steps, whole metres (5 m beyond 50).
    const deg = Math.round(way.deg / 5) * 5;
    const m = way.metres > 50 ? Math.round(way.metres / 5) * 5 : Math.round(way.metres);
    const key = `${way.label}|${deg}|${m}`;
    if (key === this.last.way) return;
    this.last.way = key;
    this.way.arrow.style.setProperty("--a", `${deg}deg`);
    this.way.label.textContent = way.label;
    this.way.metres.textContent = m <= 3 ? "here" : `${m} m`;
  }

  /** The end card: XP, the medal, where to go next (its way row follows with `setWay`), and the
   *  Star/Fork links once the repo is public. The tutorial ends here in the plaza (#68). */
  showDone(xp: number) {
    this.list.hidden = true;
    this.root.querySelector(".fl-onb__rail")?.remove();
    const c = this.card;
    c.replaceChildren();
    this.way = null;
    this.last.way = "";
    const k = el("span", "fl-onb__step-k", c, "Tutorial complete · ");
    el("b", "", k, `+${xp} XP`);
    el("h2", "", c, "You're ready");
    rich(el("p", "", c), "The **Spark** medal is yours: wear its title from the journal (**J**). **Next:** walk into the **Arcadia** portal (levels 1–7). The arrow below and the compass point the way.");
    if (this.repoUrl) this.repoLinks(c, this.repoUrl);
  }

  /**
   * The end card stays up across the walk through the portal; once the player has arrived on a
   * planet its "Next" names that planet's guide instead of the portal behind them (play-through
   * 2026-11-14: it still said "walk into the Arcadia portal … here" on Arcadia).
   */
  arrived(planet: string, guide: string) {
    const next = this.card.querySelector("p");
    if (next) next.replaceChildren();
    if (next) rich(next, `The **Spark** medal is yours: wear its title from the journal (**J**). **Next:** you're on **${planet}**: talk to **${guide}** by the pad for your first missions (the compass marks the way).`);
    this.setWay(null);
  }

  dispose() {
    removeEventListener("resize", this.onResize);
    this.panelObserver?.disconnect();
    this.root.remove();
  }
}

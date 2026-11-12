// The HUD's moments on screen (D-ui-2…4): the earned banner (one at a time, from the queue in
// moments.ts), the arrival title card, the event feed under the minimap, the "hit from" ring round
// the crosshair and the kill mark. Plain DOM (D25). Like the rest of the HUD, `tick` runs every
// frame and writes the DOM only when something changed; nothing here reads layout, and every
// animation is a transform or an opacity (styles: moments.css).

import "./moments.css";
import type { BodyId } from "@firstlight/shared/planet/bodies";
import { ARRIVAL_HOLD_MS, type ArrivalCard } from "./arrivalCard.ts";
import { el, sprite } from "./dom.ts";
import { FeedModel, feedPlain, type FeedKind, type FeedLine, type FeedPart } from "./eventFeed.ts";
import { angleGap, HIT_FROM_MAX, HIT_FROM_MS, HIT_MERGE_DEG } from "./hitFrom.ts";
import { BANNER_OUT_MS, BannerQueue, type Moment } from "./moments.ts";

const FEED_ICON: Record<FeedKind, string> = { join: "arrow-r", leave: "logout", kill: "close", death: "alert", hunt: "diamond", info: "check" };
const ARRIVAL_OUT_MS = 700;
/** Under reduced motion the wedge and the kill mark hold still this long, then go. */
const STILL_MS = 360;

let reduceQuery: MediaQueryList | null | undefined;
/** The player's reduced-motion preference, read at the moment it matters (it can change in play). */
export function prefersReducedMotion(): boolean {
  if (reduceQuery === undefined) reduceQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  return !!reduceQuery?.matches;
}

export interface MomentSlots {
  /** Top-centre column (under the zone banner, boss bar and trial strip): the banner. */
  top: HTMLElement;
  /** The right column's feed box (under the minimap). */
  feed: HTMLElement;
  /** The HUD layer: the arrival card and the hit ring are centred on it. */
  layer: HTMLElement;
}

export interface MomentsOptions {
  /** Whether to keep the hit ring and the kill mark still (default: the media query). */
  reducedMotion?: () => boolean;
}

export class MomentsHud {
  readonly queue = new BannerQueue();
  readonly feedModel = new FeedModel();
  /** A banner went up (its sound; the e2e hook's record). */
  onShow: ((m: Moment) => void) | null = null;

  private readonly banner: HTMLElement;
  private bannerEl: HTMLElement | null = null;
  private readonly feedBox: HTMLElement;
  private readonly feedEls = new Map<number, { el: HTMLElement; rev: number }>();
  private readonly arriveBox: HTMLElement;
  private arriveTimer = 0;
  private readonly ring: HTMLElement;
  private readonly wedges: { el: HTMLElement; angle: number; until: number }[] = [];
  private readonly killmark: HTMLElement;
  private readonly still: () => boolean;

  constructor(slots: MomentSlots, opts: MomentsOptions = {}) {
    this.still = opts.reducedMotion ?? prefersReducedMotion;
    this.banner = el("div", "fl-moments", slots.top);
    this.banner.setAttribute("aria-live", "polite");
    this.feedBox = slots.feed;
    this.feedBox.setAttribute("aria-live", "off"); // chatter: not read out over the game
    this.feedBox.dataset.e2e = "event-feed";
    this.arriveBox = el("div", "fl-arrive", slots.layer);
    this.arriveBox.hidden = true;
    this.arriveBox.dataset.e2e = "arrival-card";
    this.ring = el("div", "fl-hitfrom", slots.layer);
    this.ring.setAttribute("aria-hidden", "true");
    this.killmark = el("div", "fl-killmark", slots.layer);
    this.killmark.setAttribute("aria-hidden", "true");
    for (const k of ["a", "b", "c", "d"]) el("i", k, this.killmark);
  }

  // ------------------------------------------------------------------------------------------ banners

  /** Queue banners; they show one at a time from `tick`. */
  push(...moments: (Moment | null)[]): void {
    this.queue.push(...moments.filter((m): m is Moment => !!m));
  }

  /**
   * Every frame: the banner queue and the feed's clock. `hidden` (a menu or photo mode hides the HUD)
   * stops the banner clock, so nothing shows, sounds or expires unseen; the feed keeps its own time.
   */
  tick(now: number, hidden = false): void {
    if (hidden) this.queue.pause(now);
    else this.queue.resume(now);
    const step = this.queue.tick(now);
    if (step && "show" in step) this.showBanner(step.show);
    else if (step) this.hideBanner();
    if (this.feedModel.tick(now)) this.renderFeed();
  }

  private showBanner(m: Moment) {
    this.bannerEl?.remove();
    const b = el("section", `fl-moment fl-holo fl-corners is-${m.kind}`, this.banner);
    b.dataset.e2e = "moment";
    b.dataset.kind = m.kind;
    const tile = el("div", "fl-moment__icon", b);
    sprite(m.sprite, "", tile);
    const body = el("div", "fl-moment__body", b);
    el("div", "fl-moment__k", body, m.kicker);
    el("div", "fl-moment__t", body, m.title);
    const r = el("div", "fl-moment__r", body);
    if (m.key) {
      el("span", "fl-key fl-key--lit", r, m.key);
      r.append(" ");
    }
    r.append(m.reward);
    el("i", "fl-moment__sweep", b).setAttribute("aria-hidden", "true");
    this.bannerEl = b;
    this.onShow?.(m);
  }

  private hideBanner() {
    const b = this.bannerEl;
    if (!b) return;
    this.bannerEl = null;
    b.classList.add("is-out");
    window.setTimeout(() => b.remove(), BANNER_OUT_MS);
  }

  /** Drop the banner and what waits behind it (the death screen takes over). */
  clearBanners(): void {
    this.queue.clear();
    this.bannerEl?.remove();
    this.bannerEl = null;
  }

  // ------------------------------------------------------------------------------------------ arrival

  /** The title card for entering a world. A new one replaces the one still up. */
  arrival(card: ArrivalCard): void {
    window.clearTimeout(this.arriveTimer);
    const box = this.arriveBox;
    box.replaceChildren();
    box.className = "fl-arrive";
    box.dataset.body = card.body;
    box.hidden = false;
    el("div", "fl-arrive__k", box, card.kicker);
    el("div", "fl-arrive__name fl-wordmark", box, card.name).setAttribute("role", "heading");
    const sub = el("div", "fl-arrive__sub", box);
    el("span", "", sub, card.line);
    el("i", "", sub).setAttribute("aria-hidden", "true");
    el("b", "", sub, card.levels);
    this.arriveTimer = window.setTimeout(() => {
      box.classList.add("is-out");
      this.arriveTimer = window.setTimeout(() => {
        box.hidden = true;
        box.replaceChildren();
      }, ARRIVAL_OUT_MS);
    }, ARRIVAL_HOLD_MS);
  }

  // ------------------------------------------------------------------------------------------ feed

  /** Add a line; returns its id (for `feedUpdate`), or null when it repeated one just shown. */
  feed(kind: FeedKind, parts: FeedPart[], now: number): number | null {
    const line = this.feedModel.add(kind, parts, now);
    if (line) this.renderFeed();
    return line?.id ?? null;
  }

  /** Rewrite a line still on screen (a kill tally counting up). False when it has already gone. */
  feedUpdate(id: number, parts: FeedPart[], now: number): boolean {
    if (!this.feedModel.update(id, parts, now)) return false;
    this.renderFeed();
    return true;
  }

  private renderFeed() {
    const lines = this.feedModel.lines;
    const live = new Set(lines.map((l) => l.id));
    for (const [id, e] of this.feedEls) {
      if (live.has(id)) continue;
      this.feedEls.delete(id);
      e.el.classList.add("is-out");
      window.setTimeout(() => e.el.remove(), 240);
    }
    for (const l of lines) {
      const have = this.feedEls.get(l.id);
      if (!have) this.feedEls.set(l.id, { el: this.feedLine(l), rev: l.rev });
      else if (have.rev !== l.rev) {
        have.rev = l.rev;
        this.fillLine(have.el, l);
      }
    }
  }

  private feedLine(l: FeedLine): HTMLElement {
    const row = el("div", `fl-feed__line is-${l.kind}`, this.feedBox);
    this.fillLine(row, l);
    return row;
  }

  private fillLine(row: HTMLElement, l: FeedLine) {
    row.replaceChildren();
    row.title = feedPlain(l.parts);
    el("i", `li li-${FEED_ICON[l.kind]}`, row).setAttribute("aria-hidden", "true");
    const text = el("span", "fl-feed__text", row);
    for (const p of l.parts) {
      if (typeof p === "string") text.append(p);
      else {
        el("b", p.me ? "is-me" : "", text, p.name);
        if (p.agent) {
          const chip = el("span", "fl-ai", text, "AI");
          chip.title = "An AI agent";
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------ combat

  /** We were hit from `angle` (degrees clockwise from straight ahead; hitFrom.ts): a wedge on the ring. */
  hitFrom(angle: number, now: number): void {
    let w = this.wedges.find((x) => x.until > now && angleGap(x.angle, angle) <= HIT_MERGE_DEG);
    if (!w) {
      w = this.wedges.find((x) => x.until <= now);
      if (!w && this.wedges.length < HIT_FROM_MAX) {
        w = { el: el("i", "", this.ring), angle: 0, until: 0 };
        this.wedges.push(w);
      }
      w ??= this.wedges.reduce((a, b) => (a.until < b.until ? a : b)); // all four busy: the oldest turns
    }
    w.angle = angle;
    w.until = now + HIT_FROM_MS;
    w.el.style.setProperty("--a", `${Math.round(angle)}deg`);
    // Reduced motion: the wedge holds still, briefly, and goes (no fade).
    if (this.still()) w.el.animate([{ opacity: 0.9 }, { opacity: 0.9 }], { duration: STILL_MS });
    else w.el.animate([{ opacity: 0.95 }, { opacity: 0.85, offset: 0.35 }, { opacity: 0 }], { duration: HIT_FROM_MS, easing: "ease-out" });
  }

  /** Our hit killed it: the kill mark opens round the crosshair (`boss`: larger and longer). */
  kill(boss = false): void {
    this.killmark.classList.toggle("is-boss", boss);
    if (this.still()) {
      // Reduced motion: the mark shows at its resting size and goes, no scale or burst.
      this.killmark.animate([{ opacity: 1 }, { opacity: 1 }], { duration: boss ? STILL_MS * 2 : STILL_MS });
      return;
    }
    this.killmark.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) rotate(45deg) scale(.55)" },
        { opacity: 1, transform: "translate(-50%, -50%) rotate(45deg) scale(1)", offset: 0.22 },
        { opacity: 1, transform: "translate(-50%, -50%) rotate(45deg) scale(1.08)", offset: 0.6 },
        { opacity: 0, transform: "translate(-50%, -50%) rotate(45deg) scale(1.35)" },
      ],
      { duration: boss ? 900 : 520, easing: "cubic-bezier(.16, .84, .3, 1)" },
    );
  }

  /** The world accent for corners and rules (`--world`), from the body we are on. */
  setBody(root: HTMLElement, body: BodyId): void {
    if (root.dataset.body !== body) root.dataset.body = body;
  }
}

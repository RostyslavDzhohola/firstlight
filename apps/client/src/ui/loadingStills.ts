// Stills of what awaits (D-showcase-2): in-game pictures behind the full loading screen (first load
// and travel; not the compact mid-game card, not the error state), a slow crossfade from one to the
// next with a short caption naming the place, the destination body's own stills first.
//
// It must not slow the load: small WebP files (stills/, captured by tools/stills), the first one
// requested as the loader appears but at low priority, each next one only once the one before is on
// screen (one download at a time, one still ahead; a destination change or stop cancels the one on its
// way). A still that fails to load is skipped silently.
// Decorative: `alt=""` inside the loader's aria-hidden background. The look (scrim, zoom, fade,
// reduced motion) is in styles/loading.css.

import type { BodyKey } from "./loading.ts";

export interface Still {
  id: string;
  body: BodyKey;
  /** The place, shown small in a corner ("Glasswater Lake, Arcadia"). */
  caption: string;
  src: string;
  /** CSS object-position: what a narrow (phone) crop keeps; default the centre. */
  focus?: string;
}

const still = (id: string, body: BodyKey, caption: string, focus?: string): Still => ({
  id, body, caption, src: new URL(`./stills/${id}.webp`, import.meta.url).href, ...(focus ? { focus } : {}),
});

/**
 * The stills, captured from this build at Ultra on WebGPU (tools/stills/capture.ts, shots.ts; our own
 * work, CC BY 4.0, docs/ASSETS.md): 1920×1080 WebP, 48–100 KB each. Within a body, listed in the
 * order a load opens them.
 */
export const STILLS: readonly Still[] = [
  still("portus-portal", "portus", "The portals of Portus"),
  still("portus-plaza-dusk", "portus", "Portus, the castle town", "55% 50%"),
  still("portus-above", "portus", "Portus from above"),
  still("arcadia-lake", "arcadia", "Glasswater Lake, Arcadia"),
  still("arcadia-pond", "arcadia", "Clover Fields, Arcadia", "48% 50%"),
  still("hollowmere-fen", "hollowmere", "Whisper Fen, Hollowmere"),
  still("hollowmere-planet", "hollowmere", "Hollowmere at dusk", "55% 50%"),
  still("meridian-mesa", "meridian", "Cinder Canyons, Meridian", "55% 50%"),
  still("meridian-waystation", "meridian", "Waystation Nine, Meridian", "40% 50%"),
];

/**
 * How long a still stays up before the next fades in (ms), and the crossfade (matches loading.css;
 * the old still goes when its own fade ends, however long the CSS makes it: 3 s under reduced motion).
 */
export const STILL_HOLD_MS = 6000;
export const STILL_FADE_MS = 1600;

/** Bodies in the order a load with no known destination shows them (most first loads land in Portus). */
const BODY_ORDER: readonly BodyKey[] = ["portus", "arcadia", "hollowmere", "meridian"];

/**
 * Which still comes next. Each load is planned afresh (`plan(body)`): the destination's stills first,
 * which of them opens turning over from load to load, then the other bodies' in turn (no two of one
 * body back to back while another is left), round and round. Never the still just shown again
 * (while there is another); a still that failed is never offered again.
 */
export class StillDeck {
  private order: Still[] = [];
  private at = 0;
  private readonly dead = new Set<string>();
  private readonly turns = new Map<BodyKey | null, number>();
  private last: Still | null = null;

  constructor(private readonly stills: readonly Still[]) {}

  /** A new load (or a destination learnt mid-load) going to `body`; null: not known yet. */
  plan(body: BodyKey | null): void {
    const lead = body ?? BODY_ORDER.find((b) => this.stills.some((s) => s.body === b)) ?? null;
    // Turns count per opening body: a first load (no destination yet: Portus) and the arrival in
    // Portus after it open on different stills.
    const turn = this.turns.get(lead) ?? 0;
    this.turns.set(lead, turn + 1);
    const of = (b: BodyKey) => this.stills.filter((s) => s.body === b);
    const first = lead ? of(lead) : [];
    const k = first.length ? turn % first.length : 0;
    const order = [...first.slice(k), ...first.slice(0, k)];
    const rest = BODY_ORDER.filter((b) => b !== lead).map(of);
    while (rest.some((g) => g.length)) for (const g of rest) if (g.length) order.push(g.shift()!);
    this.order = order;
    this.at = 0;
  }

  /** The next still to show; null when there is none (no stills, or every one failed). */
  next(): Still | null {
    const live = this.order.filter((s) => !this.dead.has(s.id));
    if (!live.length) return null;
    for (let i = 0; i < this.order.length; i++) {
      const s = this.order[(this.at + i) % this.order.length]!;
      if (this.dead.has(s.id) || (s === this.last && live.length > 1)) continue;
      this.at = (this.at + i + 1) % this.order.length;
      return (this.last = s);
    }
    return (this.last = live[0]!);
  }

  /** `s` didn't load: skipped from now on, this session. */
  failed(s: Still): void {
    this.dead.add(s.id);
  }
}

const aborted = (signal: AbortSignal): unknown => signal.reason ?? new DOMException("The still was cancelled", "AbortError");

/**
 * Download and decode one still, at low priority, off the main thread; rejects on a broken file.
 * `signal` cancels it: the image loses its src (the browser drops the request and the decode) and the
 * promise rejects with the abort reason.
 */
export function loadStill(s: Still, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.setAttribute("fetchpriority", "low"); // before src: the request goes out at low priority
  img.src = s.src;
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const cancel = () => {
      reject(aborted(signal!));
      img.removeAttribute("src");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    img.decode().then(
      () => {
        signal?.removeEventListener("abort", cancel);
        resolve(img);
      },
      (e: unknown) => {
        signal?.removeEventListener("abort", cancel);
        reject(e);
      },
    );
  });
}

/** The element's longest transition-duration in ms; `fallback` where the browser gives none to read. */
function transitionMs(el: HTMLElement, fallback: number): number {
  const raw = typeof getComputedStyle === "function" ? getComputedStyle(el).transitionDuration : "";
  if (!raw?.trim()) return fallback;
  let ms = 0;
  for (const part of raw.split(",")) {
    const v = Number.parseFloat(part);
    if (Number.isFinite(v)) ms = Math.max(ms, part.trim().endsWith("ms") ? v : v * 1000);
  }
  return ms;
}

export interface SlideshowOptions {
  /** The catalogue (STILLS in the game). */
  stills: readonly Still[];
  /** Default loadStill; `signal` aborts when the slideshow no longer wants that still. */
  load?: (s: Still, signal: AbortSignal) => Promise<HTMLImageElement>;
  holdMs?: number;
  fadeMs?: number;
}

/**
 * The slideshow inside `container` (the loader's aria-hidden background). `start(body)` on each full
 * load, `body(b)` when the destination becomes known, `stop()` when the screen hides, turns compact or
 * shows an error: nothing more is downloaded, and the pictures go (their memory back to the game).
 */
export function stillsSlideshow(container: HTMLElement, opts: SlideshowOptions) {
  const deck = new StillDeck(opts.stills);
  const load = opts.load ?? loadStill;
  const hold = opts.holdMs ?? STILL_HOLD_MS;
  const fade = opts.fadeMs ?? STILL_FADE_MS;
  /** The one download on its way; start/stop/body cancel it (a cancelled one is dropped if it lands). */
  let inflight: AbortController | null = null;
  let running = false;
  let shownAt = 0;
  let current: { still: Still; el: HTMLElement } | null = null;
  let waiting: { still: Still; img: HTMLImageElement } | null = null;
  let holdTimer = 0;
  let destination: BodyKey | null = null;

  const clock = () => (typeof performance === "undefined" ? Date.now() : performance.now());

  function cancel() {
    inflight?.abort();
    inflight = null;
  }

  function fetchNext() {
    cancel();
    const s = deck.next();
    if (!s) return;
    const mine = new AbortController();
    inflight = mine;
    load(s, mine.signal).then(
      (img) => {
        if (mine.signal.aborted || !running) return;
        inflight = null;
        waiting = { still: s, img };
        // The first one goes up at once; the next after the current one's time on screen.
        const wait = current ? Math.max(0, hold - (clock() - shownAt)) : 0;
        clearTimeout(holdTimer);
        holdTimer = window.setTimeout(showWaiting, wait);
      },
      () => {
        if (mine.signal.aborted || !running) return; // cancelled, not broken
        inflight = null;
        deck.failed(s); // silently: the next one instead
        fetchNext();
      },
    );
  }

  function showWaiting() {
    if (!waiting || !running) return;
    const { still: s, img } = waiting;
    waiting = null;
    const fig = document.createElement("figure");
    fig.className = "fl-loading__still";
    fig.dataset.still = s.id;
    if (s.focus) img.style.objectPosition = s.focus;
    const cap = document.createElement("figcaption");
    cap.textContent = s.caption;
    fig.append(img, cap);
    container.append(fig);
    container.classList.add("has-still");
    const old = current;
    current = { still: s, el: fig };
    shownAt = clock();
    // Next frame: from opacity 0, so the fade runs (the old one fades out under it, then goes).
    requestAnimationFrame(() => requestAnimationFrame(() => fig.classList.add("is-on")));
    if (old) retire(old.el);
    fetchNext();
  }

  /** The old still fades out under the new one and goes when its fade ends (a timer as the backstop). */
  function retire(el: HTMLElement) {
    const ms = transitionMs(el, fade);
    el.classList.remove("is-on");
    if (ms <= 0) {
      el.remove(); // no fade: a plain swap
      return;
    }
    let timer = 0;
    const done = (e?: Event) => {
      if (e && (e.target !== el || (e as TransitionEvent).propertyName !== "opacity")) return; // a child's, or another property
      el.removeEventListener("transitionend", done);
      clearTimeout(timer);
      el.remove();
    };
    el.addEventListener("transitionend", done);
    timer = window.setTimeout(() => done(), ms + 100);
  }

  return {
    /** A full load starts (first load or travel) towards `body` (null: not known yet). */
    start(body: BodyKey | null) {
      if (running) return;
      running = true;
      destination = body;
      deck.plan(body);
      fetchNext();
    },
    /** The destination became known (or changed) while loading: the next still is from there. */
    body(body: BodyKey | null) {
      if (!running || body === destination) return;
      destination = body;
      if (current?.still.body === body) return;
      cancel();
      waiting = null;
      clearTimeout(holdTimer);
      deck.plan(body);
      fetchNext();
    },
    stop() {
      if (!running) return;
      running = false;
      cancel();
      waiting = null;
      clearTimeout(holdTimer);
      current = null;
      container.replaceChildren();
      container.classList.remove("has-still");
    },
    /** The still on screen (tests, e2e). */
    shown(): string | null {
      return current?.still.id ?? null;
    },
  };
}

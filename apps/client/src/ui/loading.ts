// Loading screen (verdict: Entry A layout). Game.ts calls setLoading(text, frac) with its status lines;
// loadingPhase() maps each line to one of the four named boot steps, so Game.ts keeps plain text.
// Re-entrant: mid-game status lines ("Applying graphics settings…", "Reconnecting…") use a compact
// card over the world instead of the full screen. A failed boot swaps the progress for an error with
// a Retry button (showLoadingError); the next setLoading() goes back to progress.

export type BodyKey = "portus" | "arcadia" | "hollowmere" | "meridian";

export const BOOT_STEPS = [
  { name: "Renderer", note: "WebGPU or WebGL2" },
  { name: "Connecting", note: "a seat in a world copy" },
  { name: "Building the world", note: "streaming terrain" },
  { name: "Warming shaders", note: "a few hidden frames" },
] as const;

const BODY_INFO: Record<BodyKey, { name: string; blurb: string }> = {
  portus: { name: "Portus", blurb: "The hub town: safe inside its walls, creeps outside. Three portals, one shop, a wall of first names." },
  arcadia: { name: "Arcadia", blurb: "Green fields, a turquoise lake and the Brightbits. Levels 1–7." },
  hollowmere: { name: "Hollowmere", blurb: "Violet dusk over the marsh. The Hollow Court walks here. Levels 6–13." },
  meridian: { name: "Meridian", blurb: "Red canyons and chrome towers. Meridian Oversight is watching. Levels 12–20." },
};

export const TIPS = [
  "Touch a fast-travel pad to discover it. Discovered pads are one of the few things death doesn't take, along with your name and medals.",
  "Portus town is safe inside its walls, and every pad has a 12 m safe ring: no damage in or out.",
  "Die and everything you carry drops into a pile of light. It never expires, so you can walk back for it.",
  "Logging out outside a safe zone takes 30 seconds, standing still. On a pad it's instant.",
  "No boss can be beaten alone. Bring friends.",
  "C dodge-rolls, with a moment of invulnerability. R reloads.",
  "Hold the right mouse button to aim, block or charge, depending on your weapon.",
];

export interface LoadingPhase {
  step: number;
  /** Destination body when the line names one ("Travelling to Arcadia…"). */
  body: BodyKey | null;
  /** Mid-game lines that show the compact card instead of the full screen. */
  compact: boolean;
}

/** Map a Game.ts status line to a boot step. Unknown lines keep the previous step. */
export function loadingPhase(text: string, prev: LoadingPhase = { step: 0, body: null, compact: false }): LoadingPhase {
  const t = text.trim();
  const travel = /^Travelling to (\w+)/i.exec(t);
  if (travel) {
    const key = travel[1]!.toLowerCase();
    return { step: 1, body: key in BODY_INFO ? (key as BodyKey) : prev.body, compact: false };
  }
  if (/^(Loading the game|Starting the renderer)/i.test(t)) return { ...prev, step: 0, compact: false };
  if (/^Reconnecting/i.test(t)) return { ...prev, step: 1, compact: true };
  if (/^Connecting/i.test(t)) return { ...prev, step: 1 };
  if (/^(Building the world|Loading characters)/i.test(t)) return { ...prev, step: 2 };
  if (/^Applying graphics/i.test(t)) return { ...prev, step: 3, compact: true };
  if (/^(Tuning graphics|Warming up shaders)/i.test(t)) return { ...prev, step: 3 };
  return prev;
}

// ------------------------------------------------------------------------------------------------ DOM

let root: HTMLElement | null = null;
let phase: LoadingPhase = { step: 0, body: null, compact: false };
let tipIndex = Math.floor(Math.random() * TIPS.length);
let tipTimer = 0;
const refs: {
  title?: HTMLElement; blurb?: HTMLElement; status?: HTMLElement; pct?: HTMLElement; fill?: HTMLElement;
  steps?: HTMLElement[]; tip?: HTMLElement; dots?: HTMLElement[]; badge?: HTMLElement; bar?: HTMLElement;
  card?: HTMLElement; error?: HTMLElement | null;
} = {};
let last = { text: "", pct: -1, step: -1, body: "" as string, compact: false };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function build(): HTMLElement {
  if (root) return root;
  root = document.getElementById("loading") ?? el("div", "fl-ui fl-loading", document.body);
  root.classList.add("fl-ui", "fl-loading");
  root.setAttribute("aria-live", "polite");
  root.replaceChildren();

  const bg = el("div", "fl-loading__bg", root);
  bg.setAttribute("aria-hidden", "true");
  el("div", "fl-loading__stars", bg);
  const orbit = el("div", "fl-loading__orbit", bg);
  for (let i = 0; i < 3; i++) el("i", "", orbit);
  el("div", "fl-loading__orb", bg);
  el("div", "fl-grain", bg);

  const page = el("div", "fl-loading__page", root);
  const top = el("header", "fl-loading__top", page);
  const mark = el("div", "fl-wordmark fl-wordmark--sm", top, "First");
  el("b", "", mark, "light");
  refs.badge = el("span", "fl-loading__badge", top);

  const main = el("main", "fl-loading__main", page);
  const load = el("section", "fl-loading__card", main);
  refs.card = load;
  el("span", "fl-eyebrow", load, "Loading");
  const h1 = el("h1", "fl-loading__title", load);
  refs.title = el("span", "", h1, "Firstlight");
  refs.blurb = el("small", "", h1, "Getting the world ready.");
  const prog = el("div", "fl-loading__prog", load);
  const row = el("div", "fl-loading__row", prog);
  const status = el("span", "fl-loading__status", row);
  el("span", "fl-loading__spin", status);
  refs.status = el("span", "", status, "Loading the game…");
  refs.pct = el("span", "fl-loading__pct num", row, "0%");
  refs.bar = el("div", "fl-loading__bar", prog);
  refs.bar.setAttribute("role", "progressbar");
  refs.bar.setAttribute("aria-valuemin", "0");
  refs.bar.setAttribute("aria-valuemax", "100");
  refs.fill = el("i", "", refs.bar);
  const steps = el("ol", "fl-loading__steps", prog);
  refs.steps = BOOT_STEPS.map((s) => {
    const li = el("li", "fl-loading__step", steps);
    el("span", "", li, s.name);
    el("small", "", li, s.note);
    return li;
  });

  const foot = el("footer", "fl-loading__foot", page);
  const tip = el("aside", "fl-loading__tip fl-panel fl-panel--quiet", foot);
  el("i", "li li-compass fl-loading__tipicon", tip);
  const tipBody = el("div", "", tip);
  el("h3", "fl-label", tipBody, "Tip");
  refs.tip = el("p", "", tipBody);
  const dots = el("div", "fl-loading__dots", tipBody);
  refs.dots = TIPS.map(() => el("i", "", dots));
  el("span", "fl-loading__meta", foot, "Pointer lock comes back when the world is ready");
  showTip();
  return root;
}

function showTip() {
  if (!refs.tip || !refs.dots) return;
  refs.tip.textContent = TIPS[tipIndex]!;
  refs.dots.forEach((d, i) => d.classList.toggle("is-on", i === tipIndex));
}

function clearError(r: HTMLElement) {
  if (!refs.error) return;
  refs.error.remove();
  refs.error = null;
  r.classList.remove("fl-loading--error");
}

/** Show (or update) the loading screen. `frac` is 0–1. */
export function setLoading(text: string, frac: number): void {
  const r = build();
  clearError(r);
  phase = loadingPhase(text, phase);
  if (r.hidden) {
    r.hidden = false;
    clearInterval(tipTimer);
    tipTimer = window.setInterval(() => {
      tipIndex = (tipIndex + 1) % TIPS.length;
      showTip();
    }, 7000);
  }
  if (phase.compact !== last.compact) {
    r.classList.toggle("fl-loading--compact", phase.compact);
    last.compact = phase.compact;
  }
  if (text !== last.text) refs.status!.textContent = last.text = text;
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  if (pct !== last.pct) {
    last.pct = pct;
    refs.pct!.textContent = `${pct}%`;
    refs.fill!.style.setProperty("--fill", String(pct / 100));
    refs.bar!.setAttribute("aria-valuenow", String(pct));
  }
  if (phase.step !== last.step) {
    last.step = phase.step;
    refs.steps!.forEach((s, i) => {
      s.classList.toggle("is-done", i < phase.step);
      s.classList.toggle("is-now", i === phase.step);
    });
  }
  const body = phase.body ?? "";
  if (body !== last.body) {
    last.body = body;
    const info = phase.body ? BODY_INFO[phase.body] : null;
    refs.title!.textContent = info?.name ?? "Firstlight";
    refs.blurb!.textContent = info?.blurb ?? "Getting the world ready.";
    r.dataset.body = body;
  }
}

export interface LoadingError {
  title: string;
  text: string;
  /** The main button (e.g. "Retry"). */
  action: string;
  onAction: () => void;
  /** An optional second button (e.g. back to the start page). */
  back?: string;
  onBack?: () => void;
}

/** Replace the progress with an error and a Retry button (full screen; never a stuck spinner). */
export function showLoadingError(e: LoadingError): void {
  const r = build();
  clearError(r);
  if (r.hidden) r.hidden = false;
  r.classList.remove("fl-loading--compact");
  last.compact = false;
  phase = { ...phase, compact: false };
  r.classList.add("fl-loading--error");
  const box = el("div", "fl-loading__error", refs.card);
  box.setAttribute("role", "alert");
  el("h2", "fl-loading__errtitle", box, e.title);
  el("p", "fl-loading__errtext", box, e.text);
  const row = el("div", "fl-loading__erractions", box);
  const go = el("button", "fl-btn fl-btn--primary fl-btn--lg", row, e.action);
  go.type = "button";
  go.onclick = () => e.onAction();
  if (e.back && e.onBack) {
    const back = el("button", "fl-btn fl-btn--ghost", row, e.back);
    back.type = "button";
    back.onclick = () => e.onBack!();
  }
  refs.error = box;
  go.focus();
}

export function hideLoading(): void {
  if (!root || root.hidden) return;
  clearError(root);
  root.hidden = true;
  clearInterval(tipTimer);
  // Next show starts fresh at the right step; a compact card must not stick to a full load.
  phase = { step: 0, body: phase.body, compact: false };
}

/** Small top-right badge, e.g. "WebGPU · Medium (auto)". */
export function setLoadingBadge(text: string): void {
  build();
  refs.badge!.textContent = text;
}

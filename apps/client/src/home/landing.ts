// The home page under the loading screen (#21, D-home-8). Play shows the opaque loader at once; the
// landing used to stay live under it for ~10 s (cards, animations, the home poll) until the renderer
// was up, and a frame that lost the loader's layer showed it. Now, once the loader has been on screen
// for a frame, the landing leaves the page: not displayed, inert, and home.ts stops polling. The way
// back (a failed load's "Back to the home page") shows it again and home.ts fetches fresh data at once.
// A logout reloads the page, so it starts fresh anyway. Tiny on purpose: main.ts imports it.

type Listener = (shown: boolean) => void;
const listeners = new Set<Listener>();
/** Bumped by every show/hide: a hide still waiting for its frames is dropped when this moves on. */
let generation = 0;

function set(landing: HTMLElement, shown: boolean): void {
  landing.style.display = shown ? "" : "none";
  landing.inert = !shown;
  // Back from a failed load, the game's UI layer (#ui: the HUD it already built) would paint over the
  // page (.fl-home is z 0): home.css keeps it hidden while this is on.
  landing.ownerDocument.body.classList.toggle("fl-home-up", shown);
  for (const fn of listeners) fn(shown);
}

/**
 * Call right after the loader is shown. The landing goes two frames later, so the loader has been
 * drawn over it first: no frame between them shows neither. `nextFrame` is requestAnimationFrame.
 */
export function hideLandingUnderLoader(landing: HTMLElement | null, nextFrame: (fn: () => void) => void = (fn) => requestAnimationFrame(() => fn())): void {
  if (!landing) return;
  const mine = ++generation;
  nextFrame(() =>
    nextFrame(() => {
      if (mine === generation) set(landing, false);
    }),
  );
}

/** Back to the home page: displayed, interactive, polling (home.ts listens). */
export function showLanding(landing: HTMLElement | null): void {
  generation++;
  if (landing) set(landing, true);
}

/** The landing was shown (true) or taken out of the page (false). */
export function onLandingShown(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

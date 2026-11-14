// The root `pnpm dev`'s per-run key for reading dev sign-in codes (#84, tools/dev.ts; D-sec3-6). No
// server hands it out: the Vite dev server prints a link in the developer's terminal with the key in
// the URL fragment (`#fl-dev-key=…`), which a browser never sends anywhere; the page opened from it
// keeps the key in this origin's storage and takes it out of the address bar. A proxy in front of the
// dev servers, a LAN neighbour or another site has no request to make that returns it (review round
// three, #2). Used only behind __FL_DEV_CODES__ (a literal false in every build, so none of this
// is bundled).

/** The fragment parameter of the printed link. */
export const DEV_KEY_PARAM = "fl-dev-key";
const STORE_KEY = "fl.devSigninKey";

type Store = Pick<Storage, "getItem" | "setItem"> | null;

/**
 * At page load: a key in the fragment is kept (replacing an older run's) and the fragment goes from
 * the address bar (`replace`: history.replaceState). Returns the key now kept, or null.
 */
export function adoptDevKey(loc: { pathname: string; search: string; hash: string }, store: Store, replace: (url: string) => void): string | null {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const key = params.get(DEV_KEY_PARAM);
  if (key) {
    try {
      store?.setItem(STORE_KEY, key);
    } catch {
      /* storage blocked: this page only */
    }
    params.delete(DEV_KEY_PARAM);
    const rest = params.toString();
    replace(`${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
    return key;
  }
  return devKeyIn(store);
}

/** The key this browser kept for this origin (the latest run's link it opened), or null. */
export function devKeyIn(store: Store): string | null {
  try {
    return store?.getItem(STORE_KEY) || null;
  } catch {
    return null;
  }
}

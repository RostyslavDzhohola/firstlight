// Leaving the game for the home page (6a): log out, "Back to the start" after a removal. The page
// reloads into home rather than tearing the game down in place: navigation frees the renderer, the
// GPU device, the frame loop, workers, audio and every listener at once, so nothing can leak. The
// game bundle is cached, so Play again only re-downloads nothing.

/** sessionStorage key: why we came home (read once by the home page). */
export const HOME_NOTICE_KEY = "fl.home.notice";
export type HomeNotice = "logged-out";

/** The home page URL: same page and flags, minus ?autoplay (it would start the game again) and the hash. */
export function homeUrl(href: string): string {
  const u = new URL(href);
  const kept = u.search.slice(1).split("&").filter((p) => p && decodeURIComponent(p.split("=")[0]!) !== "autoplay");
  u.search = kept.length ? `?${kept.join("&")}` : "";
  u.hash = "";
  return u.toString();
}

export function goHome(notice?: HomeNotice): void {
  try {
    if (notice) sessionStorage.setItem(HOME_NOTICE_KEY, notice);
  } catch {}
  document.exitPointerLock?.();
  location.replace(homeUrl(location.href));
}

/** The notice left by goHome, once. */
export function takeHomeNotice(): HomeNotice | null {
  try {
    const v = sessionStorage.getItem(HOME_NOTICE_KEY);
    sessionStorage.removeItem(HOME_NOTICE_KEY);
    return v === "logged-out" ? v : null;
  } catch {
    return null;
  }
}

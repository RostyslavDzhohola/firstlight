// The only part of the E2E test hook that ships in the main bundle: a URL check. The hook itself
// (debug/e2eHook.ts) is a separate chunk, fetched and installed only when the page URL has `?e2e`
// (Playwright journeys in apps/client/e2e, SPEC §9.3). Without it nothing is loaded and no global is set.

/** True when the query string asks for the test hook (`?e2e`, any value). */
export function e2eRequested(search: string): boolean {
  return new URLSearchParams(search).has("e2e");
}

/** Install the hook on `target` (window) when requested; `load` is the dynamic import of the hook. */
export function maybeInstallE2e<T>(
  search: string,
  target: T,
  load: () => Promise<{ installE2eHook(target: T): void }>,
): Promise<boolean> {
  if (!e2eRequested(search)) return Promise.resolve(false);
  return load().then(
    (m) => {
      m.installE2eHook(target);
      return true;
    },
    (e: unknown) => {
      console.warn("[e2e] hook failed to load", e);
      return false;
    },
  );
}

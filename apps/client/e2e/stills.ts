// What the loading screen showed behind it (D-showcase-2): every still that came up, with the body
// the loader was loading, in page time. An init script polls the loader, so it sees first loads too.

import type { Page } from "@playwright/test";

export interface StillSeen {
  id: string;
  caption: string;
  /** The loader's body (data-body) when it came up; "" before the destination is known. */
  body: string;
  /** performance.now() in the page. */
  t: number;
}

/** Start watching, before the page loads. */
export async function watchStills(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: StillSeen[] = ((window as unknown as { __stillsSeen: StillSeen[] }).__stillsSeen = []);
    setInterval(() => {
      const root = document.getElementById("loading");
      const fig = root && !root.hidden ? root.querySelector<HTMLElement>(".fl-loading__still.is-on") : null;
      const id = fig?.dataset.still;
      if (!id || seen.at(-1)?.id === id) return;
      seen.push({ id, caption: fig!.querySelector("figcaption")?.textContent ?? "", body: root!.dataset.body ?? "", t: performance.now() });
    }, 100);
  });
}

/** The stills seen so far (since `since`, page time), and how many pictures the loader holds now. */
export async function stillsSeen(page: Page, since = -Infinity): Promise<{ seen: StillSeen[]; inDom: number }> {
  return page.evaluate((since) => ({
    seen: ((window as unknown as { __stillsSeen?: StillSeen[] }).__stillsSeen ?? []).filter((s) => s.t >= since),
    inDom: document.querySelectorAll("#loading .fl-loading__still").length,
  }), since);
}

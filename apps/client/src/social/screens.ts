// Full-screen notices: the queue (when /api/play answers {queue}) and "removed from the world"
// (kicked, banned, or signed in somewhere else).

import { CLOSE } from "@firstlight/shared/net/social";
import { el } from "./dom.ts";
import { overlayClosed, overlayOpened } from "../ui/dom.ts";
import { goHome } from "../home/leave.ts";

let queueEl: HTMLDivElement | null = null;

/** Show/update the queue screen; null hides it. Net retries /api/play every 5 s meanwhile. */
export function showQueue(q: { position: number; etaSeconds: number } | null): void {
  if (!q) {
    queueEl?.remove();
    queueEl = null;
    overlayClosed("queue");
    return;
  }
  if (!queueEl) {
    queueEl = el("div", "fl-overlay fl-queue");
    overlayOpened("queue");
    document.body.appendChild(queueEl);
  }
  queueEl.replaceChildren();
  const p = el("div", "fl-panel", queueEl);
  el("h2", "", p, "THE WORLD IS FULL");
  el("p", "", p, "You're in the queue. We'll let you in automatically — keep this tab open.");
  el("div", "pos", p, `#${q.position}`);
  const mins = Math.max(1, Math.round(q.etaSeconds / 60));
  el("p", "", p, q.etaSeconds > 0 ? `About ${mins} minute${mins === 1 ? "" : "s"}.` : "Any moment now.");
}

let removedEl: HTMLDivElement | null = null;
let lastReason = "";

/** The server's `kicked` message arrives just before the close code. */
export function noteRemovalReason(reason: string): void {
  lastReason = reason;
}

const TEXT: Record<string, { title: string; body: string; again: boolean }> = {
  [CLOSE.KICKED]: { title: "REMOVED", body: "An admin removed you from the world. You can come back in a couple of minutes.", again: true },
  [CLOSE.BANNED]: { title: "BANNED", body: "This account can't play FIRSTLIGHT any more.", again: false },
  [CLOSE.ELSEWHERE]: { title: "PLAYING ELSEWHERE", body: "Your character just entered the world from another tab or browser.", again: true },
  kicked: { title: "NOT YET", body: "An admin removed you a moment ago. Try again in a couple of minutes.", again: true },
  banned: { title: "BANNED", body: "This account can't play FIRSTLIGHT any more.", again: false },
};

/** Codes that must not auto-rejoin. */
export function isRemoval(code: number): boolean {
  return code === CLOSE.KICKED || code === CLOSE.BANNED || code === CLOSE.ELSEWHERE;
}

export function showRemoved(code: number | string): void {
  const t = TEXT[String(code)];
  if (!t || removedEl) return;
  overlayOpened("removed"); // final: the page reloads from here
  document.exitPointerLock?.();
  removedEl = el("div", "fl-overlay fl-removed");
  const p = el("div", "fl-panel", removedEl);
  el("h2", "", p, t.title);
  el("p", "", p, t.body);
  if (lastReason && code !== CLOSE.ELSEWHERE) el("p", "", p, `Reason: ${lastReason}`);
  if (t.again) {
    const b = el("button", "fl-btn", p, code === CLOSE.ELSEWHERE ? "Play here instead" : "Back to the home page");
    b.onclick = () => goHome();
  }
  document.body.appendChild(removedEl);
}

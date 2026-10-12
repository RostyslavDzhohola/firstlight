// Party invite cards: "X invites you to their party" with Accept (Y) / Decline (N) and a 60 s timer.
// Clickable while the mouse is free; Y/N work while playing.

import type { PartyInviteMsg } from "@firstlight/shared/net/social";
import { el, sbtn } from "./dom.ts";
import { pendingInvites, removeInvite } from "./store.ts";

export class InviteCards {
  private readonly root = el("div", "fl-invites");
  private shown = "";

  constructor(private readonly answer: (inv: PartyInviteMsg, accept: boolean) => void) {
    document.body.appendChild(this.root);
  }

  /** The invite Y/N would answer (newest). */
  current(): PartyInviteMsg | null {
    const list = pendingInvites();
    return list[list.length - 1] ?? null;
  }

  respond(accept: boolean): boolean {
    const inv = this.current();
    if (!inv) return false;
    this.answer(inv, accept);
    removeInvite(inv.from);
    this.render();
    return true;
  }

  render() {
    const list = pendingInvites().slice(-3);
    const key = list.map((i) => `${i.from}:${i.expiresAt}`).join("|");
    if (key !== this.shown) {
      this.shown = key;
      this.root.replaceChildren();
      list.forEach((inv, idx) => {
        const card = el("div", "fl-invite", this.root);
        const p = el("div", "", card);
        el("b", "", p, inv.fromName);
        p.append(inv.partyId ? " invites you to their party." : " wants to start a party with you.");
        const row = el("div", "row", card);
        const newest = idx === list.length - 1;
        sbtn(newest ? "Accept (Y)" : "Accept", () => this.respondTo(inv, true), "primary", row);
        sbtn(newest ? "Decline (N)" : "Decline", () => this.respondTo(inv, false), "", row);
        const bar = el("div", "ttl", card);
        bar.dataset.exp = String(inv.expiresAt);
      });
    }
    const now = Date.now();
    for (const bar of this.root.querySelectorAll<HTMLElement>(".ttl")) {
      const left = Math.max(0, Number(bar.dataset.exp) - now);
      bar.style.transform = `scaleX(${Math.min(1, left / 60_000).toFixed(3)})`;
    }
  }

  private respondTo(inv: PartyInviteMsg, accept: boolean) {
    this.answer(inv, accept);
    removeInvite(inv.from);
    this.render();
  }

  dispose() {
    this.root.remove();
  }
}

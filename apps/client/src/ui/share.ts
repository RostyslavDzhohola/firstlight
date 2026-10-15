// Share row (6e), on the home page and in the Esc menu, after littleprince.dev's bar: Share (the Web
// Share sheet where there is one, else copy the link), Email (a mailto: invite), Follow on X (only
// when VITE_X_HANDLE is set: it publishes under the owner's name, so never guessed) and, on the home
// page, an eye that hides the page to show the backdrop. Screenshots stay on P (the photo share).

import "./share.css";
import { config } from "../config.ts";
import { button, el, icon } from "./dom.ts";
import { inviteMailto, SHARE_TEXT, SHARE_TITLE, SHARE_URL, xFollowUrl, xHandle } from "./shareLinks.ts";

export interface ShareRowOptions {
  /** Show the hide-UI eye; called with the new state. */
  onHideUi?: (hidden: boolean) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function shareRow(parent: HTMLElement, opts: ShareRowOptions = {}): HTMLElement {
  const row = el("div", "fl-share", parent);
  row.dataset.e2e = "share-row";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Share FIRSTLIGHT");
  const toast = el("span", "fl-share__toast");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  let toastTimer = 0;
  const say = (text: string) => {
    toast.textContent = text;
    toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-on"), 2600);
  };

  const share = button("", "fl-share__btn", row);
  share.dataset.share = "link";
  icon("share", "", share);
  share.append("Share");
  share.onclick = async () => {
    const data: ShareData = { title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL };
    if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // the player closed the sheet
      }
    }
    say((await copyText(SHARE_URL)) ? "Link copied" : `Copy this link: ${SHARE_URL.replace("https://", "")}`);
  };

  el("i", "fl-share__sep", row).setAttribute("aria-hidden", "true");
  const mail = el("a", "fl-share__btn", row);
  mail.dataset.share = "email";
  mail.href = inviteMailto();
  icon("mail", "", mail);
  mail.append("Email");

  const handle = xHandle(config.xHandle);
  if (handle) {
    el("i", "fl-share__sep", row).setAttribute("aria-hidden", "true");
    const x = el("a", "fl-share__btn", row);
    x.dataset.share = "x";
    x.href = xFollowUrl(handle);
    x.target = "_blank";
    x.rel = "noopener";
    x.append("Follow on ");
    el("b", "fl-share__x", x, "𝕏").setAttribute("aria-label", "X");
  }

  if (opts.onHideUi) {
    el("i", "fl-share__sep", row).setAttribute("aria-hidden", "true");
    const eye = button("", "fl-share__btn fl-share__btn--icon", row);
    eye.dataset.share = "hide-ui";
    let hidden = false;
    const paint = () => {
      eye.replaceChildren();
      icon(hidden ? "eye-off" : "eye", "", eye);
      eye.setAttribute("aria-pressed", String(hidden));
      eye.setAttribute("aria-label", hidden ? "Show the page" : "Hide the page and look at the view");
      eye.title = hidden ? "Show the page" : "Hide the page";
    };
    eye.onclick = () => {
      hidden = !hidden;
      paint();
      opts.onHideUi!(hidden);
    };
    paint();
  }
  row.appendChild(toast);
  return row;
}

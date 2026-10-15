// @vitest-environment happy-dom
// The account cards are real modals (Codex review, should-fix 5): while one is open, Tab stays inside
// it, the page behind is inert (the home page's Sign in / Play can't be reached), Esc closes it, and
// focus goes back where it was.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as AccountT from "./account.ts";

let account: typeof AccountT;

beforeAll(async () => {
  history.replaceState(null, "", "/?devguest"); // no account lookups
  account = await import("./account.ts");
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.replaceChildren();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const tab = (shift = false) => {
  const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(ev);
  return ev;
};

function page() {
  const behind = document.createElement("button");
  behind.id = "play";
  behind.textContent = "Play";
  const ui = document.createElement("div");
  ui.id = "ui";
  document.body.append(behind, ui);
  behind.focus();
  return { behind, ui };
}

describe("account cards are modal", () => {
  it("makes the page behind inert, keeps Tab inside the card, and gives focus back on Esc", async () => {
    const { behind, ui } = page();
    const done = account.showSignIn({ preview: "email" });
    await tick();
    const card = document.querySelector<HTMLElement>("[data-e2e=signin-card]")!;
    expect(card).toBeTruthy();
    expect(behind.hasAttribute("inert")).toBe(true);
    expect(ui.hasAttribute("inert")).toBe(true);
    expect(card.closest(".fl-overlay")!.hasAttribute("inert")).toBe(false);
    const focusables = [...card.querySelectorAll<HTMLElement>("input, button")];
    expect(focusables.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(focusables[0]); // the email field

    focusables.at(-1)!.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]); // wraps forward
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables.at(-1)); // and backward

    behind.removeAttribute("inert"); // even if something escaped to the page, Tab comes back in
    behind.focus();
    tab();
    expect(card.contains(document.activeElement)).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await done).toBe("dismissed");
    expect(document.querySelector("[data-e2e=signin-card]")).toBeNull();
    expect(ui.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(behind);
  });

  it("leaves alone what was already inert", async () => {
    const { ui } = page();
    ui.setAttribute("inert", "");
    const done = account.showSignIn({ preview: "unavailable" });
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await done;
    expect(ui.hasAttribute("inert")).toBe(true);
  });
});

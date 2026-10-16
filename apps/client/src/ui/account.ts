// Account UI (HANDOFF 5c, the owner's final decision: guests play with one click; the email is asked
// for only to save progress, and the save card never needs the mouse while the game holds it):
//   openSaveProgress()  the save card, modal: email → 6-digit code → saved. Opens only with the mouse
//                       free (Esc menu, death screen, home page); says up front when
//                       saving is unavailable, busy or not unlocked yet. Saved players never get it.
//   showSignIn()        "Sign in" for a returning player on a new browser, modal (same flow)
//   pickDisplayName()   display-name picker, modal
// Each returns a promise and is safe to call again while open (returns the open one).

import "./account.css";
import { AuthError, getAccountInfo, invalidatePlayToken, NAME_PATTERN, onAccountChange, saveStatus, savingStatus, sendEmailCode, setDisplayName, verifyEmailCode, type AccountInfo } from "../net/auth.ts";
import { button, el, icon, isolateKeys, overlayClosed, overlayOpened, sprite } from "./dom.ts";
import { codeFromText, firstSaveStep, mayOpenSaveCard, SAVE_MIN_LEVEL, type SaveStatus, type SaveStep as FlowStep } from "./saveOffer.ts";
import { installSprites, portraitSprite } from "./sprites.ts";

const RESEND_SECONDS = 60;
const RING_C = 50.3; // 2π × 8
/** The longest the card waits for its checks (normally ~50 ms) before showing the email field anyway. */
const CHECK_TIMEOUT_MS = 2500;

const FOCUSABLE = "input:not([disabled]), button:not([disabled]), a[href], select, textarea, [tabindex]:not([tabindex='-1'])";

function modal(name: string, onEscape: (() => void) | null): { overlay: HTMLDivElement; card: HTMLElement; close(): void } {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.exitPointerLock?.();
  overlayOpened(name);
  // On <body>, not in #ui: #ui is its own stacking context under the landing page (z 20), so a card
  // in it opened from the landing ("Sign in", the home page's "Save your progress") was invisible.
  const overlay = el("div", "fl-overlay fl-overlay--modal fl-ui", document.body);
  const card = el("section", "fl-modal fl-panel fl-acct", overlay);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  isolateKeys(overlay);
  // A real modal: everything else on the page is inert (Tab and clicks can't reach the home page's
  // Sign in / Play or the game behind), and focus goes back where it was on close.
  const inerted: Element[] = [];
  for (const c of Array.from(document.body.children)) {
    if (c === overlay || c.hasAttribute("inert") || c.tagName === "SCRIPT") continue;
    c.setAttribute("inert", "");
    inerted.push(c);
  }
  const trapTab = (ev: KeyboardEvent) => {
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !e.closest("[hidden]"));
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const at = document.activeElement;
    let to: HTMLElement | null = null;
    if (!card.contains(at)) to = ev.shiftKey ? last : first;
    else if (ev.shiftKey && at === first) to = last;
    else if (!ev.shiftKey && at === last) to = first;
    if (!to) return;
    ev.preventDefault();
    to.focus();
  };
  // Esc and Tab belong to the card while it's open, wherever the focus is: they never reach the game
  // or the Esc menu underneath (which would resume play behind the card).
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Tab") {
      ev.stopPropagation();
      trapTab(ev);
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      onEscape?.();
    }
  };
  document.addEventListener("keydown", onKey, true);
  return {
    overlay,
    card,
    close: () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      for (const c of inerted) c.removeAttribute("inert");
      overlayClosed(name);
      if (returnFocus?.isConnected && !document.pointerLockElement) returnFocus.focus();
    },
  };
}

function field(type: string, placeholder: string, value = ""): HTMLInputElement {
  const i = el("input", "fl-input");
  i.type = type;
  i.placeholder = placeholder;
  i.value = value;
  return i;
}

/** The player opened this card, so its field takes the keyboard (it never opens while the pointer is locked). */
function focusSoon(e: HTMLElement): void {
  setTimeout(() => {
    if (e.isConnected && !document.pointerLockElement) e.focus();
  }, 0);
}

/**
 * This browser's account for the save card. A 401 means our cached token is stale (another tab saved
 * this guest): ask once more with whatever the session is now. Any other failure is null, never "go
 * ahead": an account we couldn't look up doesn't get an email form (Codex review).
 */
async function lookUpAccount(): Promise<AccountInfo | null> {
  try {
    return await getAccountInfo();
  } catch (e) {
    if (!(e instanceof AuthError) || e.status !== 401) return null;
    invalidatePlayToken();
    return getAccountInfo().catch(() => null);
  }
}

/** Wait for `p`, or give `fallback` after `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((ok) => setTimeout(() => ok(fallback), ms))]);
}

// ---------------------------------------------------------------------------------------------
// Email → code flow shared by "save progress" and "sign in"

interface FlowOpts {
  kind: "save" | "signin";
  /** Save card header: portrait, level and name. */
  who?: { name?: string; level?: number; starter: number; look?: number };
  name?: string;
  /** Where to try again later, e.g. "Esc → Save progress". */
  later?: string;
  finish(ok: boolean): void;
  start?: FlowStep;
  startEmail?: string;
}

function emailFlow(container: HTMLElement, o: FlowOpts): void {
  const save = o.kind === "save";
  let email = o.startEmail ?? "";
  let resendTimer = 0;
  const name = o.who?.name || o.name;

  const reset = () => {
    clearInterval(resendTimer);
    container.classList.remove("fl-panel--danger");
    container.replaceChildren();
  };

  const header = (title: string) => {
    if (!o.who) {
      el("h2", "", container, title);
      return;
    }
    const who = el("div", "fl-acct__who", container);
    const face = el("div", "fl-face", who);
    sprite(portraitSprite(o.who.starter, o.who.look), "", face);
    if (o.who.level) el("span", "fl-lvl num", face, String(o.who.level));
    const t = el("div", "", who);
    el("h2", "", t, title);
    el("span", "", t, `${name || "Your character"} · guest on this browser`);
  };

  const stepEmail = () => {
    reset();
    header(save ? "Save your progress" : "Sign in");
    el("p", "", container, save
      ? `Add your email to keep ${name || "your character"} and play on any browser. We'll send a 6-digit code. No password.`
      : "Saved your character on another browser? We'll email you a 6-digit code and it comes with you.");
    if (save) el("p", "fl-fine fl-acct__guest", container, "Until you save, your progress lives in this browser only.");
    const lab = el("label", "fl-label", container, "Email");
    const input = field("email", "you@example.com", email);
    input.id = `fl-email-${Math.random().toString(36).slice(2, 7)}`;
    input.autocomplete = "email";
    input.inputMode = "email";
    input.spellcheck = false;
    lab.htmlFor = input.id;
    container.appendChild(input);
    const status = el("div", "fl-status", container);
    status.setAttribute("role", "status");
    const btns = el("div", "fl-acct__btns", container);
    const send = button("", "fl-btn fl-btn--primary", btns);
    icon("mail", "", send);
    send.append("Send code");
    button("Not now", "fl-btn fl-btn--ghost", btns, () => o.finish(false));
    el("span", "fl-fine", container, "One email with the code. Nothing else, ever.");
    const go = async () => {
      if (send.disabled) return;
      email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        status.className = "fl-status is-error";
        status.textContent = "That email doesn't look right.";
        input.classList.add("is-error");
        input.focus();
        return;
      }
      send.disabled = true;
      status.className = "fl-status";
      status.textContent = "Sending…";
      const r = await sendEmailCode(email);
      send.disabled = false;
      if (!r.ok) {
        if (r.failure === "unavailable") return stepUnavailable();
        if (r.failure === "busy") return stepBusy();
        status.className = "fl-status is-error";
        status.textContent = r.message;
        if (r.failure === "rejected") input.classList.add("is-error");
        return;
      }
      stepCode();
    };
    send.onclick = () => void go();
    input.addEventListener("input", () => {
      input.classList.remove("is-error");
      if (status.classList.contains("is-error")) status.textContent = "";
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    focusSoon(input);
  };

  const stepCode = () => {
    reset();
    el("h2", "", container, "Check your email");
    const sent = el("div", "fl-acct__sentto", container);
    el("span", "", sent, `Sent to ${email}`);
    button("Change", "", sent, () => stepEmail());

    const code = el("div", "fl-code", container);
    code.setAttribute("role", "group");
    code.setAttribute("aria-label", "6-digit code");
    const input = el("input", "", code);
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.setAttribute("aria-label", "6-digit code");
    // No maxLength: a pasted "123 456" or a whole sentence would be cut before we pick the digits out.
    const cells = Array.from({ length: 6 }, () => el("span", "", code));
    const paint = () => {
      const v = input.value;
      const focus = document.activeElement === input;
      cells.forEach((c, i) => {
        c.textContent = v[i] ?? "";
        c.classList.toggle("is-filled", i < v.length);
        c.classList.toggle("is-focus", focus && i === Math.min(v.length, 5) && v.length < 6);
      });
    };
    el("span", "fl-fine", container, "The code is in the email. It works for 5 minutes. Paste it or type it.");
    const status = el("div", "fl-status", container);
    status.setAttribute("role", "status");

    const resendRow = el("div", "fl-resend", container);
    const ringT = el("span", "fl-resend__t", resendRow);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    const bg = document.createElementNS(svgNs, "circle");
    const fg = document.createElementNS(svgNs, "circle");
    for (const c of [bg, fg]) {
      c.setAttribute("cx", "10");
      c.setAttribute("cy", "10");
      c.setAttribute("r", "8");
    }
    bg.setAttribute("class", "bg");
    fg.setAttribute("class", "fg");
    svg.append(bg, fg);
    ringT.appendChild(svg);
    const ringText = el("span", "num", ringT);
    const resend = button("", "fl-btn fl-btn--sm", resendRow);
    icon("refresh", "", resend);
    resend.append("Resend");

    const btns = el("div", "fl-acct__btns", container);
    const submit = button(save ? "Save" : "Sign in", "fl-btn fl-btn--primary", btns);
    button("Not now", "fl-btn fl-btn--ghost", btns, () => o.finish(false));

    let left = RESEND_SECONDS;
    const tick = () => {
      resend.disabled = left > 0;
      ringT.hidden = left <= 0;
      ringText.textContent = `Resend in 0:${String(Math.max(0, left)).padStart(2, "0")}`;
      fg.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, left) / RESEND_SECONDS));
      left--;
      if (left < -1) clearInterval(resendTimer);
    };
    clearInterval(resendTimer);
    tick();
    resendTimer = window.setInterval(tick, 1000);

    let checking = false;
    const go = async () => {
      if (checking) return;
      const value = input.value.replace(/\D/g, "");
      if (value.length !== 6) {
        status.className = "fl-status is-error";
        status.textContent = "Enter the 6 digits from the email.";
        return;
      }
      checking = submit.disabled = true;
      status.className = "fl-status";
      status.textContent = "Checking…";
      const r = await verifyEmailCode(email, value, name).catch(() => ({ ok: false as const, message: "Couldn't reach the server. Try again." }));
      checking = submit.disabled = false;
      if (!r.ok) {
        status.className = "fl-status is-error";
        status.textContent = r.message;
        code.classList.add("is-error");
        input.select();
        return;
      }
      clearInterval(resendTimer);
      stepSaved();
    };
    submit.onclick = () => void go();
    input.addEventListener("paste", (ev) => {
      const t = ev.clipboardData?.getData("text") ?? "";
      if (!t) return;
      ev.preventDefault();
      input.value = codeFromText(t);
      input.dispatchEvent(new Event("input"));
    });
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
      code.classList.remove("is-error");
      if (status.classList.contains("is-error")) status.textContent = "";
      paint();
      if (input.value.length === 6) void go();
    });
    input.addEventListener("focus", paint);
    input.addEventListener("blur", paint);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    resend.onclick = async () => {
      if (resend.disabled) return;
      left = RESEND_SECONDS;
      clearInterval(resendTimer);
      tick();
      resendTimer = window.setInterval(tick, 1000);
      status.className = "fl-status";
      status.textContent = "Sending…";
      const r = await sendEmailCode(email);
      if (!r.ok && r.failure === "unavailable") return stepUnavailable();
      if (!r.ok && r.failure === "busy") return stepBusy();
      status.className = `fl-status ${r.ok ? "is-ok" : "is-error"}`;
      status.textContent = r.ok ? "New code sent." : r.message;
      input.focus();
    };
    paint();
    focusSoon(input);
  };

  const stepSaved = () => {
    reset();
    // The game rejoins as the account now (close code 4101): its loading screen stays behind this card.
    container.closest(".fl-overlay")?.classList.add("fl-overlay--top");
    icon("check", "", el("div", "fl-acct__mark is-ok", container));
    el("h2", "", container, save ? "Saved." : "Signed in.");
    if (save) {
      const p = el("p", "", container);
      el("b", "", p, name || "Your character");
      p.append(` is now tied to ${email}. Use `);
      el("b", "", p, "Sign in");
      p.append(" on any browser to carry on.");
      const keeps = el("div", "fl-acct__keeps", container);
      for (const [k, v] of [["Character, level, items", "this life"], ["Name, medals, Hall of Firsts", "forever"]]) {
        const row = el("div", "", keeps, k);
        el("b", "", row, v);
      }
    }
    const btns = el("div", "fl-acct__btns", container);
    const back = button(save ? "Done" : "Continue", "fl-btn fl-btn--primary", btns, () => done());
    focusSoon(back);
    const t = window.setTimeout(() => done(), 6000);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearTimeout(t);
      o.finish(true);
    };
  };

  /** A dead end turned into an answer: why it can't happen now, and that nothing is lost. */
  const stepNote = (mark: "alert" | "lock", title: string, text: string, fine: string | null, e2e?: string) => {
    reset();
    if (mark === "alert") container.classList.add("fl-panel--danger");
    icon(mark, "", el("div", `fl-acct__mark ${mark === "alert" ? "is-err" : "is-wait"}`, container));
    const note = el("div", "fl-acct__note", container);
    if (e2e) note.dataset.e2e = e2e;
    el("h2", "", note, title);
    el("p", "", note, text);
    if (fine) el("span", "fl-fine", container, fine);
    const btns = el("div", "fl-acct__btns", container);
    focusSoon(button("OK", "fl-btn fl-btn--primary", btns, () => o.finish(false)));
  };

  const later = o.later ? `Try again from ${o.later} in a little while.` : "Try again in a little while.";

  const stepBusy = () =>
    stepNote("alert", save ? "Saving is busy, try again later." : "Signing in is busy, try again later.",
      `Too many codes are going out right now. ${save ? "Your progress is kept in this browser. Nothing is lost." : "You can still play as a guest meanwhile."}`, later);

  const stepUnavailable = () =>
    stepNote("alert", save ? "Saving is temporarily unavailable" : "Signing in is temporarily unavailable",
      save ? "We can't send email codes right now. Your progress is kept in this browser, so keep playing." : "We can't send email codes right now. You can still play as a guest; your progress is kept in this browser.",
      later, "save-unavailable");

  const stepLocked = () =>
    stepNote("lock", "Play a little first", `Saving unlocks at level ${SAVE_MIN_LEVEL}. The tutorial gets you there in about a minute; until then your progress lives in this browser.`, null);

  ({ email: stepEmail, code: stepCode, saved: stepSaved, busy: stepBusy, unavailable: stepUnavailable, locked: stepLocked })[o.start ?? "email"]();
}

// ---------------------------------------------------------------------------------------------
// Display names

/** The suggestion if it already passes the name rules, else "" (leave the field empty). */
export function validSuggestion(name: string | undefined | null): string {
  const v = (name ?? "").trim();
  return NAME_PATTERN.test(v) ? v : "";
}

/** Why a name can't be used (shown next to the disabled button). */
export function nameProblem(v: string): string {
  if (v.length === 0) return "Type a name to continue: 3–16 letters, numbers or _";
  if (v.length < 3 || v.length > 16) return "Names are 3–16 characters";
  return "Use letters, numbers and _ only (no spaces or dashes)";
}

// ---------------------------------------------------------------------------------------------
// Public API

export type SaveResult = "saved" | "dismissed";

let saveOpen: Promise<SaveResult> | null = null;

/**
 * The save card ("Save your progress": email → 6-digit code → saved), modal. For the Esc menu, the
 * death screen and the home page (logging out lands there). Never opens while the game holds the pointer,
 * and resolves "saved" at once for a saved account (nothing to ask). Moving the guest's character to
 * the account is the server's guest→account merge; the game rejoins as the account by itself (4101).
 * `later`: where to try again, for the busy/unavailable notes (e.g. "Esc → Save progress").
 */
export function openSaveProgress(opts: { name?: string; level?: number; starter?: number; look?: number; later?: string; /** Dev gallery only: open on this step, no server. */ preview?: FlowStep } = {}): Promise<SaveResult> {
  if (saveOpen) return saveOpen;
  if (!mayOpenSaveCard({ pointerLocked: !!document.pointerLockElement })) return Promise.resolve("dismissed");
  installSprites();
  saveOpen = new Promise((resolve) => {
    let done = false;
    const finish = (r: SaveResult) => {
      if (done) return;
      done = true;
      stopListening();
      m.close();
      saveOpen = null;
      resolve(r);
    };
    // Another tab saved (or signed in) meanwhile: this card is moot.
    const stopListening = onAccountChange((_claims, { elsewhere }) => {
      if (elsewhere && !done && !opts.preview) void saveStatus().then((s) => s !== "guest" && finish(s === "saved" ? "saved" : "dismissed"));
    });
    const m = modal("save", () => finish("dismissed"));
    m.card.classList.add("fl-acct--save");
    m.card.dataset.e2e = "save-card";
    m.card.setAttribute("aria-label", "Save your progress");
    const starter = () => opts.starter ?? (Number(localStorage.getItem("fl.starter") ?? 0) || 0);
    const run = (start: FlowStep, info: AccountInfo | null) =>
      emailFlow(m.card, {
        kind: "save",
        who: {
          name: opts.name ?? info?.displayName ?? info?.name,
          level: opts.level ?? info?.character?.level,
          starter: opts.starter ?? info?.character?.starter ?? starter(),
          look: opts.look ?? info?.character?.look ?? (Number(localStorage.getItem("fl.look") ?? 0) || 0),
        },
        later: opts.later,
        finish: (ok) => finish(ok ? "saved" : "dismissed"),
        start,
        startEmail: opts.preview ? "wren@example.com" : "",
      });
    if (opts.preview) return run(opts.preview, null);
    el("h2", "", m.card, "Save your progress");
    el("div", "fl-status", m.card, "One moment…");
    void (async () => {
      // The session first: asking for a play token without one would create a guest just to say "nothing to save".
      const status = await within<SaveStatus | null>(saveStatus(), CHECK_TIMEOUT_MS, null);
      if (done) return;
      // No answer: never guess "guest" (that would ask for a token, i.e. create a session); say it can't save now.
      if (status === null) return run("unavailable", null);
      // Saved players never see a save prompt; dev guests and offline runs have nothing to save.
      if (status === "saved") return finish("saved");
      if (status === "none") return finish("dismissed");
      const [saving, info] = await within(
        Promise.all([savingStatus(), lookUpAccount()]),
        CHECK_TIMEOUT_MS,
        ["ok", null] as ["ok" | "busy" | "unavailable", AccountInfo | null],
      );
      if (done) return;
      if (info?.guest === false) return finish("saved");
      // No account to look at: say saving can't happen right now rather than ask for an email.
      if (!info) return run("unavailable", null);
      run(firstSaveStep({ saving, saveReady: info.saveReady }), info);
    })();
  });
  return saveOpen;
}

let signInOpen: Promise<"signed-in" | "dismissed"> | null = null;

/** "Sign in" (a returning player on a new browser): same account and character. */
export function showSignIn(opts: { /** Dev gallery only: open on this step, no server. */ preview?: FlowStep } = {}): Promise<"signed-in" | "dismissed"> {
  if (signInOpen) return signInOpen;
  signInOpen = new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      m.close();
      signInOpen = null;
      resolve(ok ? "signed-in" : "dismissed");
    };
    const m = modal("signin", () => finish(false));
    m.card.dataset.e2e = "signin-card";
    m.card.setAttribute("aria-label", "Sign in");
    const run = (start: FlowStep) => emailFlow(m.card, { kind: "signin", finish, start, startEmail: opts.preview ? "wren@example.com" : "" });
    if (opts.preview) return run(opts.preview);
    // Open on the email field at once; switch to the note if codes can't go out right now.
    run("email");
    void within(savingStatus(), CHECK_TIMEOUT_MS, "ok" as const).then((saving) => {
      if (done || saving === "ok") return;
      const typed = (m.card.querySelector("input[type=email]") as HTMLInputElement | null)?.value;
      if (m.card.querySelector("input[type=email]") && !typed) run(saving);
    });
  });
  return signInOpen;
}

let nameOpen: Promise<string | null> | null = null;

/**
 * Display-name picker (first play). Resolves the accepted name, or null if dismissed
 * (only possible with `dismissible: true`).
 */
export function pickDisplayName(opts: { suggested?: string; dismissible?: boolean } = {}): Promise<string | null> {
  if (nameOpen) return nameOpen;
  nameOpen = new Promise((resolve) => {
    let done = false;
    const finish = (name: string | null) => {
      if (done) return;
      done = true;
      m.close();
      nameOpen = null;
      resolve(name);
    };
    const m = modal("name", opts.dismissible ? () => finish(null) : null);
    m.card.setAttribute("aria-label", "Pick a name");
    el("h2", "", m.card, "Pick a name");
    el("p", "", m.card, "Other players see it above your head.");
    // Only pre-fill a suggestion that passes validation (generated guest names like "Wanderer-7904" don't).
    const input = field("text", "Your name", validSuggestion(opts.suggested));
    input.maxLength = 16;
    input.setAttribute("autocomplete", "nickname");
    input.spellcheck = false;
    m.card.appendChild(input);
    const status = el("div", "fl-status", m.card, "3–16 letters, numbers or _");
    const btns = el("div", `fl-actions ${opts.dismissible ? "fl-actions--split" : "fl-actions--end"}`, m.card);
    if (opts.dismissible) button("Later", "fl-btn fl-btn--ghost", btns, () => finish(null));
    const ok = button("Play as this name", "fl-btn fl-btn--primary", btns);
    const check = () => {
      const v = input.value.trim();
      const valid = NAME_PATTERN.test(v);
      ok.disabled = !valid;
      ok.title = valid ? "" : nameProblem(v);
      input.classList.toggle("is-error", v.length > 0 && !valid);
      status.className = `fl-status${v.length > 0 && !valid ? " is-error" : ""}`;
      // Always say why the button is disabled.
      status.textContent = valid ? "3–16 letters, numbers or _" : nameProblem(v);
      return valid;
    };
    const go = async () => {
      if (!check()) return;
      ok.disabled = true;
      status.textContent = "Checking…";
      const r = await setDisplayName(input.value.trim()).catch(() => ({ ok: false as const, message: "Couldn't reach the server. Try again." }));
      if (r.ok) return finish(r.name);
      ok.disabled = false;
      status.className = "fl-status is-error";
      status.textContent = r.message;
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    ok.onclick = () => void go();
    check();
    setTimeout(() => input.focus(), 0);
  });
  return nameOpen;
}

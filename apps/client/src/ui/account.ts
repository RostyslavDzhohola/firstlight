// Account UI (verdict: Entry B save card, all four states):
//   showSavePrompt()   non-blocking "Save your character" card docked bottom-right: email → 6-digit code
//                      (resend locked 60 s with a ring) → saved; or "Saving is busy" when the OTP budget refuses
//   showSignIn()       "Sign in with email" (second browser), modal
//   pickDisplayName()  display-name picker, modal
// Each returns a promise and is safe to call again while open (returns the open one).

import "./account.css";
import { getPlayToken, NAME_PATTERN, readClaims, sendEmailCode, setDisplayName, verifyEmailCode } from "../net/auth.ts";
import { button, el, icon, isolateKeys, overlayClosed, overlayOpened, sprite, uiRoot } from "./dom.ts";
import { installSprites, portraitSprite } from "./sprites.ts";

const RESEND_SECONDS = 60;
const RING_C = 50.3; // 2π × 8

function modal(name: string, onEscape: (() => void) | null): { overlay: HTMLDivElement; card: HTMLElement; close(): void } {
  document.exitPointerLock?.();
  overlayOpened(name);
  const overlay = el("div", "fl-overlay fl-overlay--modal fl-ui", uiRoot());
  const card = el("section", "fl-modal fl-panel fl-acct", overlay);
  card.setAttribute("role", "dialog");
  isolateKeys(overlay);
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && onEscape) onEscape();
  });
  return {
    overlay,
    card,
    close: () => {
      overlay.remove();
      overlayClosed(name);
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

// ---------------------------------------------------------------------------------------------
// Email → code flow shared by "save" and "sign in"

interface EmailFlowText {
  title: string;
  intro: string;
  submit: string;
  done: string;
  /** Optional header (portrait + level) for the save card. */
  who?: { name?: string; level?: number; starter: number };
}

type FlowStep = "email" | "code" | "saved" | "busy";

function emailFlow(container: HTMLElement, text: EmailFlowText, name: string | undefined, finish: (ok: boolean) => void, start: FlowStep = "email", startEmail = ""): void {
  let email = startEmail;
  let resendTimer = 0;

  const header = (h: HTMLElement, title: string) => {
    if (!text.who) {
      el("h2", "", h, title);
      return;
    }
    const who = el("div", "fl-acct__who", h);
    const face = el("div", "fl-face", who);
    sprite(portraitSprite(text.who.starter), "", face);
    if (text.who.level) el("span", "fl-lvl num", face, String(text.who.level));
    const t = el("div", "", who);
    el("h2", "", t, title);
    el("span", "", t, `${text.who.name || name || "Your character"} · guest on this browser`);
  };

  const stepEmail = () => {
    clearInterval(resendTimer);
    container.classList.remove("fl-panel--danger");
    container.replaceChildren();
    header(container, text.who?.level ? `Level ${text.who.level}!` : text.title);
    el("p", "", container, text.intro);
    const lab = el("label", "fl-label", container, "Email");
    const input = field("email", "you@example.com", email);
    input.id = `fl-email-${Math.random().toString(36).slice(2, 7)}`;
    input.autocomplete = "email";
    input.inputMode = "email";
    lab.htmlFor = input.id;
    container.appendChild(input);
    const status = el("div", "fl-status", container);
    const btns = el("div", "fl-acct__btns", container);
    const send = button("", "fl-btn fl-btn--primary", btns);
    icon("mail", "", send);
    send.append("Send code");
    button("Not now", "fl-btn fl-btn--ghost", btns, () => finish(false));
    el("span", "fl-fine", container, "One email with the code. Nothing else, ever.");
    const go = async () => {
      email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        status.className = "fl-status is-error";
        status.textContent = "That email doesn't look right.";
        input.classList.add("is-error");
        return;
      }
      send.disabled = true;
      status.className = "fl-status";
      status.textContent = "Sending…";
      const r = await sendEmailCode(email);
      send.disabled = false;
      if (!r.ok) {
        if (r.busy) return stepBusy();
        status.className = "fl-status is-error";
        status.textContent = r.message;
        return;
      }
      stepCode();
    };
    send.onclick = () => void go();
    input.addEventListener("input", () => input.classList.remove("is-error"));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    setTimeout(() => input.focus(), 0);
  };

  const stepCode = () => {
    container.replaceChildren();
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
    input.maxLength = 6;
    input.setAttribute("aria-label", "6-digit code");
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
    el("span", "fl-fine", container, "The code is in the email. It works for 5 minutes.");
    const status = el("div", "fl-status", container);

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
    const submit = button(text.submit, "fl-btn fl-btn--primary", btns);
    button("Not now", "fl-btn fl-btn--ghost", btns, () => finish(false));

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

    const go = async () => {
      const value = input.value.replace(/\D/g, "");
      if (value.length !== 6) {
        status.className = "fl-status is-error";
        status.textContent = "Enter the 6 digits from the email.";
        return;
      }
      submit.disabled = true;
      status.className = "fl-status";
      status.textContent = "Checking…";
      const r = await verifyEmailCode(email, value, name);
      submit.disabled = false;
      if (!r.ok) {
        status.className = "fl-status is-error";
        status.textContent = r.message;
        code.classList.add("is-error");
        return;
      }
      clearInterval(resendTimer);
      stepSaved();
    };
    submit.onclick = () => void go();
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
      code.classList.remove("is-error");
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
      if (!r.ok && r.busy) return stepBusy();
      status.className = `fl-status ${r.ok ? "is-ok" : "is-error"}`;
      status.textContent = r.ok ? "New code sent." : r.message;
    };
    paint();
    setTimeout(() => input.focus(), 0);
  };

  const stepSaved = () => {
    container.replaceChildren();
    icon("check", "", el("div", "fl-acct__mark is-ok", container));
    el("h2", "", container, text.who ? "Saved." : text.done);
    if (text.who) {
      const p = el("p", "", container);
      el("b", "", p, name || "Your character");
      p.append(` is now tied to ${email}. Use `);
      el("b", "", p, "Sign in with email");
      p.append(" on any browser to carry on.");
      const keeps = el("div", "fl-acct__keeps", container);
      for (const [k, v] of [["Character, level, items", "this life"], ["Name, medals, Hall of Firsts", "forever"]]) {
        const row = el("div", "", keeps, k);
        el("b", "", row, v);
      }
    }
    const btns = el("div", "fl-acct__btns", container);
    const back = button(text.who ? "Back to the game" : "Continue", "fl-btn fl-btn--primary", btns, () => done());
    back.focus();
    const t = window.setTimeout(() => done(), 4500);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearTimeout(t);
      finish(true);
    };
  };

  const stepBusy = () => {
    clearInterval(resendTimer);
    container.classList.add("fl-panel--danger");
    container.replaceChildren();
    icon("alert", "", el("div", "fl-acct__mark is-err", container));
    el("h2", "", container, "Saving is busy, try again later.");
    el("p", "", container, "Too many codes are going out right now. You're still playing as a guest on this browser. Nothing is lost.");
    el("span", "fl-fine", container, "Try again from Esc → Save your character in a little while.");
    const btns = el("div", "fl-acct__btns", container);
    button("OK", "fl-btn fl-btn--primary", btns, () => finish(false)).focus();
  };

  ({ email: stepEmail, code: stepCode, saved: stepSaved, busy: stepBusy })[start]();
}

async function currentName(): Promise<string | undefined> {
  try {
    return readClaims(await getPlayToken())?.name || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Public API

let saveOpen: Promise<"saved" | "dismissed"> | null = null;

/**
 * Non-blocking "Save your character" card (bottom-right; the game keeps running). Shown after the
 * first level-up. Resolves "saved" once the email code is accepted, else "dismissed".
 */
export function showSavePrompt(opts: { name?: string; level?: number; starter?: number; /** Dev gallery only: open on a later state. */ preview?: FlowStep } = {}): Promise<"saved" | "dismissed"> {
  if (saveOpen) return saveOpen;
  installSprites();
  saveOpen = new Promise((resolve) => {
    const card = el("section", "fl-savecard fl-panel fl-acct fl-ui", uiRoot());
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Save your character");
    isolateKeys(card);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") finish(false);
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      card.remove();
      saveOpen = null;
      resolve(ok ? "saved" : "dismissed");
    };
    void (async () => {
      const name = opts.name ?? (await currentName());
      emailFlow(
        card,
        {
          title: "Save your character",
          intro: `Save ${name || "your character"} to play on any browser. We'll email you a 6-digit code. No password.`,
          submit: "Save",
          done: "Saved.",
          who: { name, level: opts.level, starter: opts.starter ?? (Number(localStorage.getItem("fl.starter") ?? 0) || 0) },
        },
        name,
        finish,
        opts.preview,
        opts.preview ? "wren@example.com" : "",
      );
    })();
  });
  return saveOpen;
}

let signInOpen: Promise<"signed-in" | "dismissed"> | null = null;

/** "Sign in with email" (e.g. a second browser): same account and character. */
export function showSignIn(): Promise<"signed-in" | "dismissed"> {
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
    m.card.setAttribute("aria-label", "Sign in with email");
    void (async () => {
      const name = await currentName();
      emailFlow(
        m.card,
        {
          title: "Sign in with email",
          intro: "We'll email you a 6-digit code. Your saved character comes with you.",
          submit: "Sign in",
          done: "Signed in.",
        },
        name,
        finish,
      );
    })();
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
    const input = field("text", "Your name", opts.suggested ?? "");
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
      input.classList.toggle("is-error", v.length > 0 && !valid);
      status.className = "fl-status";
      status.textContent = v.length > 0 && !valid ? (v.length < 3 || v.length > 16 ? "Names are 3–16 characters." : "Use letters, numbers and _ only.") : "3–16 letters, numbers or _";
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

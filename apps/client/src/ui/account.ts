// Minimal account UI (plain DOM, inline styles; the UI lane restyles later):
//   showSavePrompt()   non-blocking "Save your character" card: email → 6-digit code → done
//   showSignIn()       "Sign in with email" (second browser), modal
//   pickDisplayName()  display-name picker, modal
// Each returns a promise and is safe to call again while open (returns the open one).

import { getPlayToken, NAME_PATTERN, readClaims, sendEmailCode, setDisplayName, verifyEmailCode } from "../net/auth.ts";

const C = {
  bg: "rgba(11, 6, 24, 0.94)",
  border: "1px solid #3a2a5e",
  text: "#ece8f6",
  dim: "#b9b2cc",
  faint: "#8f88a8",
  accent: "linear-gradient(180deg, #ffb86b, #ff7edb)",
  ok: "#7dffb0",
  err: "#ff8a8a",
};

type Kids = (Node | string | null | false)[];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration> = {}, props: Record<string, unknown> = {}, kids: Kids = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  for (const [k, v] of Object.entries(props)) (e as unknown as Record<string, unknown>)[k] = v;
  for (const k of kids) if (k) e.append(k);
  return e;
}

const inputStyle: Partial<CSSStyleDeclaration> = {
  width: "100%",
  boxSizing: "border-box",
  font: "inherit",
  fontSize: "16px",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid #4a3a72",
  background: "#140d28",
  color: C.text,
  outline: "none",
  margin: "8px 0",
};

function button(label: string, primary = true): HTMLButtonElement {
  return h(
    "button",
    {
      font: "inherit",
      fontSize: "15px",
      fontWeight: primary ? "700" : "500",
      padding: primary ? "10px 22px" : "8px 12px",
      borderRadius: "999px",
      border: primary ? "1px solid #ffd8a8" : "none",
      background: primary ? C.accent : "transparent",
      color: primary ? "#1a0f2a" : C.dim,
      cursor: "pointer",
    },
    { type: "button", textContent: label },
  );
}

function uiRoot(): HTMLElement {
  return document.getElementById("ui") ?? document.body;
}

/** Keys typed into our fields must not reach the game's window listeners. */
function isolateKeys(e: HTMLElement): void {
  for (const type of ["keydown", "keyup", "keypress"]) e.addEventListener(type, (ev) => ev.stopPropagation());
}

function modal(onEscape: (() => void) | null): { overlay: HTMLDivElement; card: HTMLDivElement; close(): void } {
  document.exitPointerLock?.();
  const card = h("div", {
    width: "min(380px, calc(100vw - 32px))",
    background: C.bg,
    border: C.border,
    borderRadius: "16px",
    padding: "24px",
    color: C.text,
    boxShadow: "0 20px 80px #000a",
    fontSize: "15px",
    lineHeight: "1.45",
  });
  const overlay = h("div", { position: "fixed", inset: "0", display: "grid", placeItems: "center", background: "rgba(5, 4, 9, 0.6)", zIndex: "60", pointerEvents: "auto" }, {}, [card]);
  isolateKeys(overlay);
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && onEscape) onEscape();
  });
  uiRoot().append(overlay);
  return { overlay, card, close: () => overlay.remove() };
}

// ---------------------------------------------------------------------------------------------
// Email → code flow shared by "save" and "sign in"

interface EmailFlowText {
  title: string;
  intro: string;
  submit: string;
  done: string;
}

function emailFlow(container: HTMLElement, text: EmailFlowText, name: string | undefined, finish: (ok: boolean) => void): void {
  const RESEND_SECONDS = 60;
  let email = "";
  let resendTimer = 0;

  const title = h("div", { fontSize: "18px", fontWeight: "700", marginBottom: "4px" }, { textContent: text.title });
  const body = h("div");
  const status = h("div", { minHeight: "20px", fontSize: "14px", color: C.err, marginTop: "6px" });
  container.append(title, body, status);

  const setStatus = (msg: string, color = C.err) => {
    status.textContent = msg;
    status.style.color = color;
  };

  const stepEmail = () => {
    clearInterval(resendTimer);
    setStatus("");
    const input = h("input", inputStyle, { type: "email", placeholder: "you@example.com", autocomplete: "email", value: email, inputMode: "email" });
    const send = button("Send code");
    const later = button("Not now", false);
    const row = h("div", { display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", marginTop: "6px" }, {}, [later, send]);
    body.replaceChildren(h("div", { color: C.dim }, { textContent: text.intro }), input, row);
    const go = async () => {
      email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setStatus("That email doesn't look right.");
      send.disabled = true;
      setStatus("Sending…", C.faint);
      const r = await sendEmailCode(email);
      send.disabled = false;
      if (!r.ok) return setStatus(r.message);
      stepCode();
    };
    send.onclick = () => void go();
    later.onclick = () => finish(false);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    setTimeout(() => input.focus(), 0);
  };

  const stepCode = () => {
    setStatus("");
    const input = h("input", { ...inputStyle, fontSize: "22px", letterSpacing: "0.4em", textAlign: "center" }, {
      type: "text",
      inputMode: "numeric",
      autocomplete: "one-time-code",
      maxLength: 6,
      placeholder: "······",
    });
    const submit = button(text.submit);
    const resend = button("Resend code", false);
    const other = button("Use a different email", false);
    const sent = h("div", { color: C.dim }, {}, ["We sent a 6-digit code to ", h("b", {}, { textContent: email }), ". It expires in 5 minutes."]);
    body.replaceChildren(
      sent,
      input,
      h("div", { display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", marginTop: "6px" }, {}, [h("div", {}, {}, [resend, other]), submit]),
    );

    let left = RESEND_SECONDS;
    const tick = () => {
      resend.disabled = left > 0;
      resend.style.opacity = left > 0 ? "0.5" : "1";
      resend.style.cursor = left > 0 ? "default" : "pointer";
      resend.textContent = left > 0 ? `Resend in ${left}s` : "Resend code";
      left--;
      if (left < -1) clearInterval(resendTimer);
    };
    clearInterval(resendTimer);
    tick();
    resendTimer = window.setInterval(tick, 1000);

    const go = async () => {
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) return setStatus("Enter the 6 digits from the email.");
      submit.disabled = true;
      setStatus("Checking…", C.faint);
      const r = await verifyEmailCode(email, code, name);
      submit.disabled = false;
      if (!r.ok) return setStatus(r.message);
      clearInterval(resendTimer);
      body.replaceChildren(h("div", { color: C.ok }, { textContent: text.done }));
      setStatus("");
      setTimeout(() => finish(true), 2200);
    };
    submit.onclick = () => void go();
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
      if (input.value.length === 6) void go();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    resend.onclick = async () => {
      if (resend.disabled) return;
      left = RESEND_SECONDS;
      tick();
      setStatus("Sending…", C.faint);
      const r = await sendEmailCode(email);
      setStatus(r.ok ? "New code sent." : r.message, r.ok ? C.ok : C.err);
    };
    other.onclick = () => stepEmail();
    setTimeout(() => input.focus(), 0);
  };

  stepEmail();
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
export function showSavePrompt(opts: { name?: string } = {}): Promise<"saved" | "dismissed"> {
  if (saveOpen) return saveOpen;
  saveOpen = new Promise((resolve) => {
    const card = h("div", {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      width: "min(340px, calc(100vw - 40px))",
      background: C.bg,
      border: C.border,
      borderRadius: "14px",
      padding: "18px 20px",
      color: C.text,
      fontSize: "15px",
      lineHeight: "1.45",
      zIndex: "50",
      boxShadow: "0 10px 50px #0009",
      pointerEvents: "auto",
    });
    isolateKeys(card);
    uiRoot().append(card);
    void (async () => {
      const name = opts.name ?? (await currentName());
      emailFlow(
        card,
        {
          title: "Save your character",
          intro: "Get a 6-digit code by email to keep your character, name and medals, and to play on other browsers.",
          submit: "Save",
          done: "Saved. Sign in with this email on any browser to keep playing.",
        },
        name,
        (ok) => {
          card.remove();
          saveOpen = null;
          resolve(ok ? "saved" : "dismissed");
        },
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
    const m = modal(() => finish(false));
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
    const m = modal(opts.dismissible ? () => finish(null) : null);
    const input = h("input", inputStyle, { type: "text", maxLength: 16, autocomplete: "nickname", spellcheck: false, value: opts.suggested ?? "", placeholder: "Your name" });
    const status = h("div", { minHeight: "20px", fontSize: "14px", color: C.faint, marginTop: "2px" }, { textContent: "3–16 letters, numbers or _" });
    const ok = button("Play as this name");
    const skip = opts.dismissible ? button("Later", false) : null;
    m.card.append(
      h("div", { fontSize: "18px", fontWeight: "700", marginBottom: "4px" }, { textContent: "Pick a name" }),
      h("div", { color: C.dim }, { textContent: "Other players see it above your head." }),
      input,
      status,
      h("div", { display: "flex", gap: "8px", justifyContent: skip ? "space-between" : "flex-end", marginTop: "8px" }, {}, [skip, ok]),
    );
    const check = () => {
      const v = input.value.trim();
      const valid = NAME_PATTERN.test(v);
      ok.disabled = !valid;
      ok.style.opacity = valid ? "1" : "0.5";
      status.style.color = C.faint;
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
      status.style.color = C.err;
      status.textContent = r.message;
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void go();
    });
    ok.onclick = () => void go();
    if (skip) skip.onclick = () => finish(null);
    check();
    setTimeout(() => input.focus(), 0);
  });
  return nameOpen;
}

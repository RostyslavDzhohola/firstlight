// The home page (6a, 6e, 6f): fills the cards in index.html from GET /api/home (polled while the
// page is visible) and, when this browser has a session, from /api/account/me; wires Sign in, Save
// your progress, Sign out, the leaderboard tabs and the share row. Loaded after first paint, so
// Play works before any of this arrives. Opening the page never creates a guest: only Play does.

import type { HomeBoard, HomeData, HomeOnline, HomeVisits } from "@firstlight/shared/net/home";
import { config } from "../config.ts";
import { button, el, icon, sprite } from "../ui/dom.ts";
import { shareRow } from "../ui/share.ts";
import { installSprites, portraitSprite } from "../ui/sprites.ts";
import { fmtNum, hallRows, namesLine, progressView, visitsLine, worldCards, type MeInfo } from "./homeModel.ts";
import { takeHomeNotice, type HomeNotice } from "./leave.ts";
import { signOutSession } from "./signOut.ts";
import { dataFastNote } from "./datafast.ts";

const POLL_MS = 20_000;
type Tab = "levels" | "hall" | "medals";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

function landingVisible(): boolean {
  const l = $("landing");
  return !!l && l.style.display !== "none";
}

// ------------------------------------------------------------------------------------- renderers

/** Online now: each body's count and who's there. */
export function renderOnline(online: HomeOnline | null): void {
  const list = $("home-online-list");
  const total = $("home-online-total");
  if (!list || !total) return;
  total.replaceChildren();
  el("i", "fl-live-dot", total).setAttribute("aria-hidden", "true");
  el("b", "num", total, online ? fmtNum(online.total) : "–");
  if (online) total.append(online.total === 1 ? " player" : " players");
  list.replaceChildren();
  for (const w of worldCards(online)) {
    const li = el("li", `is-${w.id}`, list);
    el("i", "dot", li).setAttribute("aria-hidden", "true");
    el("span", "w", li, w.name);
    el("b", `n num${w.players ? "" : " is-zero"}`, li, online ? fmtNum(w.players) : "–");
    el("span", "who", li, online ? namesLine(online.bodies[w.id].names, w.players) : "…");
  }
}

/** The four worlds: a planet, level range, boss, pads and players there now. */
export function renderWorlds(online: HomeOnline | null): void {
  const box = $("home-worlds");
  if (!box) return;
  box.replaceChildren();
  for (const w of worldCards(online)) {
    const card = el("article", `fl-panel fl-panel--quiet fl-home__world fl-home__worldc--${w.id}`, box);
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-label", w.name);
    const top = el("div", "fl-home__wtop", card);
    el("i", `fl-planet fl-planet--${w.id}`, top).setAttribute("aria-hidden", "true");
    const t = el("div", "", top);
    el("h3", "", t, w.name);
    el("small", "", t, w.levels);
    el("p", "fl-home__blurb", card, w.blurb);
    el("div", "", card); // grid filler: keeps the meta row at the bottom
    const meta = el("div", "fl-home__wmeta", card);
    if (w.boss) {
      const b = el("span", "", meta);
      sprite("crown", "", b);
      b.append(`${w.boss.name} · Lv ${w.boss.level}`);
    } else {
      const s = el("span", "", meta);
      icon("shield", "", s);
      s.append("No fighting");
    }
    const p = el("span", "", meta);
    el("b", "num", p, online ? fmtNum(w.players) : "–");
    p.append(" here");
  }
}

function boardRow(list: HTMLElement, opts: { rank?: number; sprite: string; name: string; tag?: string | null; val: string; unit?: string; open?: boolean }) {
  const li = el("li", opts.open ? "is-open" : "", list);
  el("span", "rank", li, opts.rank ? String(opts.rank) : "");
  sprite(opts.sprite, "", el("span", "icon", li));
  const n = el("span", "name", li, opts.name);
  if (opts.tag) el("small", "", n, opts.tag);
  const v = el("span", "val", li, opts.val);
  if (opts.unit) el("small", "", v, opts.unit);
}

/** Fade the leaderboard's foot while more rows sit below. */
function markMore(body: HTMLElement): void {
  body.classList.toggle("is-more", body.scrollTop + body.clientHeight < body.scrollHeight - 4);
}

/** The leaderboard's open tab. */
export function renderBoard(board: HomeBoard | null, tab: Tab): void {
  const body = $("home-board");
  if (!body) return;
  if (!body.dataset.more) {
    body.dataset.more = "1";
    body.addEventListener("scroll", () => markMore(body), { passive: true });
  }
  requestAnimationFrame(() => markMore(body));
  body.scrollTop = 0;
  body.replaceChildren();
  if (!board) {
    el("p", "fl-home__empty", body, "The leaderboard is resting. Check back in a minute.");
    return;
  }
  const list = el("ol", "fl-home__rows", body);
  if (tab === "levels") {
    board.levels.forEach((r, i) => boardRow(list, { rank: i + 1, sprite: portraitSprite(r.starter), name: r.name, tag: r.title, val: `Lv ${r.level}` }));
    if (!board.levels.length) el("p", "fl-home__empty", body, "No one has made the board yet. Pick a name, play a little, and it's yours.");
  } else if (tab === "medals") {
    board.medals.forEach((r, i) => boardRow(list, { rank: i + 1, sprite: "medal", name: r.name, tag: r.title, val: fmtNum(r.medals), unit: r.medals === 1 ? " medal" : " medals" }));
    if (!board.medals.length) el("p", "fl-home__empty", body, "No medals yet. The first one is for finishing the tutorial.");
  } else {
    for (const r of hallRows(board.hall)) boardRow(list, { sprite: r.name ? "trophy" : "lock", name: r.label, tag: r.name ? `by ${r.name}` : null, val: r.date ?? "Unclaimed", open: !r.name });
  }
}

/** "Online now: N · Total visits: M" (DataFast), or our own player count without it. */
export function renderVisits(visits: HomeVisits | null, ourOnline: number | null): void {
  const box = $("home-visits");
  if (!box) return;
  const line = visitsLine(visits, ourOnline);
  box.hidden = !line;
  if (!line) return;
  box.replaceChildren();
  el("i", "fl-live-dot", box).setAttribute("aria-hidden", "true");
  const on = el("span", "", box, "Online now: ");
  el("b", "num", on, line.online);
  if (line.total !== null) {
    el("i", "sep", box).setAttribute("aria-hidden", "true");
    const tot = el("span", "", box, "Total visits: ");
    el("b", "num", tot, line.total);
  }
  // The page carries DataFast's script: say so, and say "cookieless" only when it is.
  const note = dataFastNote(config.datafast);
  if (note) el("span", "note", box, `· ${note}`);
}

export interface MeState {
  me: MeInfo | null;
  notice: HomeNotice | null;
  /** A failed sign-out: shown with a retry; the account stays on the page. */
  error?: string | null;
}

export interface MeActions {
  save(): void;
  signOut(): void;
}

/** My progress, the account corner, the Play label and the guest's Save button. */
export function renderMe({ me, notice, error }: MeState, actions?: MeActions): void {
  const card = $("home-progress");
  const has = !!me && (!!me.character || me.medals.length > 0 || !!me.displayName);
  const v = has ? progressView(me!, Number(localStorage.getItem("fl.starter") ?? 0) || 0) : null;
  const saved = !!me && !me.guest;

  // Account corner.
  const who = $("home-who");
  if (who) {
    who.hidden = !v;
    who.replaceChildren();
    if (v) {
      icon(saved ? "check" : "lock", "", who);
      who.append(saved ? v.name : `${v.name} · guest`);
      who.title = saved ? "Saved: sign in on any browser with your email" : "A guest on this browser";
    }
  }
  const signout = $("signout");
  if (signout) signout.hidden = !saved;
  const signin = $("signin");
  if (signin) signin.hidden = saved;

  // Play / Continue.
  const label = $("play-label");
  if (label) label.textContent = v?.playing ? "Continue" : "Play";
  const play = $("play");
  if (play) play.setAttribute("aria-label", v?.playing ? `Continue as ${v.name}, level ${v.level}` : "Play");

  // Save your progress (guests with something to save).
  const save = $<HTMLButtonElement>("home-save");
  if (save) {
    save.hidden = !(v && !saved && v.playing);
    // The server emails a code to a new address only after the first level-up (F12 OTP budget).
    save.disabled = !!v && v.level < 2;
    save.title = save.disabled ? "Unlocks at level 2: play a little first" : "Keep this character on any browser with an email code";
    if (actions) save.onclick = () => actions.save();
  }

  // Notices: a failed sign-out (with a retry), else the logged-out line.
  const n = $("home-notice");
  if (n) {
    n.hidden = !error && !notice;
    n.classList.toggle("is-error", !!error);
    n.replaceChildren();
    if (error) {
      icon("alert", "", n);
      el("span", "", n, error);
      if (actions) button("Try again", "fl-btn fl-btn--sm", n, () => actions.signOut());
    } else if (notice === "logged-out") {
      icon("check", "", n);
      n.append(saved || !v ? `Logged out. ${v ? v.name : "Your character"} is saved where you left it.` : "Logged out. Your guest character waits in this browser. Save it to play anywhere.");
    }
  }

  if (!card) return;
  card.hidden = !v;
  card.replaceChildren();
  if (!v) return;
  const head = el("header", "fl-home__head", card);
  el("h2", "", head, "My progress");
  el("span", `fl-chip ${saved ? "fl-chip--ok" : "fl-chip--dawn"}`, head, saved ? "Saved" : "Guest");
  const meRow = el("div", "fl-home__me", card);
  const face = el("div", "fl-face", meRow);
  sprite(portraitSprite(v.starter), "", face);
  el("span", "fl-lvl num", face, String(v.level));
  const t = el("div", "", meRow);
  const nm = el("b", "", t, v.name);
  if (v.title) el("span", "fl-home__title", t, `«${v.title}»`);
  else nm.title = v.name;
  el("span", "", t, v.playing ? `${v.starterName} · level ${v.level} · on ${v.body}` : "Between lives: Play to be reborn in Portus");
  if (v.playing) {
    const xp = el("div", "fl-home__xp", card);
    const bar = el("div", "fl-bar", xp);
    bar.style.setProperty("--fill", v.xpFrac.toFixed(3));
    el("i", "", bar);
    el("span", "", xp, v.xpText);
  }
  const dl = el("dl", "fl-home__stats", card);
  const stat = (spriteName: string | null, iconName: string | null, label: string, value: string) => {
    const d = el("div", "", dl);
    const dt = el("dt", "", d);
    if (spriteName) sprite(spriteName, "", dt);
    if (iconName) icon(iconName, "", dt);
    dt.append(label);
    el("dd", "num", d, value);
  };
  if (v.playing) stat("coin", null, "Coins", fmtNum(v.coins));
  stat("medal", null, "Medals", `${v.medals} / ${v.medalsTotal}`);
  stat("prism", null, "Pads found", `${v.pads} / ${v.padsTotal}`);
  stat(null, "clock", "This life", v.playTime);
  if (!saved) el("p", "fl-home__guest", card, v.playing && v.level < 2 ? "Guest progress lives in this browser only. From level 2 you can save it with your email." : "Guest progress lives in this browser only, until you save it with your email.");
}

// ------------------------------------------------------------------------------------------- data

async function fetchHome(): Promise<HomeData | null> {
  try {
    const r = await fetch(`${config.apiUrl}/api/home`, { signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as HomeData) : null;
  } catch {
    return null;
  }
}

/** This browser's account, if it already has a session (never signs in as a guest). */
async function fetchMe(): Promise<MeInfo | null> {
  try {
    const auth = await import("../net/auth.ts");
    if (!auth.isDevGuest()) {
      const s = await auth.authClient().getSession();
      if (!s.data) return null;
    }
    return (await auth.getAccountInfo()) as unknown as MeInfo;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------- page

export async function initHome(): Promise<void> {
  installSprites();
  const landing = $("landing");
  let tab: Tab = "levels";
  let data: HomeData | null = null;
  const state: MeState = { me: null, notice: takeHomeNotice() };

  const share = $("home-share");
  if (share) shareRow(share, { onHideUi: (hidden) => landing?.classList.toggle("is-bare", hidden) });

  for (const b of document.querySelectorAll<HTMLButtonElement>("#home-leaderboard [data-tab]")) {
    b.onclick = () => {
      tab = b.dataset.tab as Tab;
      for (const o of document.querySelectorAll<HTMLButtonElement>("#home-leaderboard [data-tab]")) o.setAttribute("aria-selected", String(o === b));
      renderBoard(data?.board ?? null, tab);
    };
  }

  const paintData = () => {
    renderOnline(data?.online ?? null);
    renderWorlds(data?.online ?? null);
    if (data) renderBoard(data.board, tab);
    renderVisits(data?.visits ?? null, data ? data.online.total : null);
  };
  const actions: MeActions = { save: () => void saveProgress(), signOut: () => void signOut() };
  const paintMe = () => renderMe(state, actions);
  const refreshMe = async () => {
    state.me = await fetchMe();
    paintMe();
  };

  async function saveProgress() {
    // TODO(save lane): open the new save card here: `openSaveProgress()` from ui/account.ts.
    const { showSavePrompt } = await import("../ui/account.ts");
    const v = state.me ? progressView(state.me) : null;
    const r = await showSavePrompt({ name: v?.name, level: v?.level, starter: v?.starter, requested: true });
    if (r === "saved") await refreshMe();
  }

  $("signin")?.addEventListener("click", async () => {
    // TODO(save lane): the save lane's sign-in card replaces this when it lands (same promise contract).
    const { showSignIn } = await import("../ui/account.ts");
    if ((await showSignIn()) === "signed-in") {
      await refreshMe();
      $("play")?.focus();
    }
  });

  let signingOut = false;
  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    const b = $<HTMLButtonElement>("signout");
    if (b) b.disabled = true;
    let ok = false;
    try {
      const auth = await import("../net/auth.ts");
      const r = await signOutSession(auth.authClient());
      auth.invalidatePlayToken(); // either way: the next token comes from whatever session is left
      ok = r.ok;
      state.error = r.ok ? null : r.message;
    } catch {
      state.error = "Couldn't load the sign-out. Check your connection and try again.";
    } finally {
      signingOut = false;
      if (b) b.disabled = false;
    }
    if (ok) {
      // The next player on this browser starts fresh (a signed-in account restores these from the server).
      for (const k of ["fl.starter", "fl.palette", "fl.body"]) localStorage.removeItem(k);
      state.notice = null;
      state.me = null;
    }
    paintMe(); // on failure the account stays, with the error and a retry
  }
  $("signout")?.addEventListener("click", () => void signOut());

  paintData();
  paintMe();
  const poll = async () => {
    if (document.hidden || !landingVisible()) return;
    const next = await fetchHome();
    if (next) {
      data = next;
      paintData();
    } else if (!data) renderBoard(null, tab); // the server is unreachable: say so instead of an empty card
  };
  void poll();
  window.setInterval(() => void poll(), POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
  await refreshMe();
}

/** Dev gallery: paint the page from mock data, no network. */
export function paintHomeMock(data: HomeData, me: MeInfo | null, notice: HomeNotice | null = null): void {
  installSprites();
  const share = $("home-share");
  if (share && !share.firstChild) shareRow(share, { onHideUi: (h) => $("landing")?.classList.toggle("is-bare", h) });
  renderOnline(data.online);
  renderWorlds(data.online);
  renderBoard(data.board, "levels");
  renderVisits(data.visits, data.online.total);
  renderMe({ me, notice });
}

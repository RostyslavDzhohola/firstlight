// The home page (6a, 6e, 6f): fills the cards in index.html from GET /api/home (polled while the
// page is visible) and, when this browser has a session, from /api/account/me; wires Sign in, Save
// your progress, Sign out, the leaderboard tabs and the share row. Loaded after first paint, so
// Play works before any of this arrives. Opening the page never creates a guest: only Play does.

import type { HomeBoard, HomeData, HomeOnline, HomeVisits } from "@firstlight/shared/net/home";
import { config } from "../config.ts";
import { button, el, icon, sprite } from "../ui/dom.ts";
import { shareRow } from "../ui/share.ts";
import { installSprites, portraitSprite } from "../ui/sprites.ts";
import { STILLS, type Still } from "../ui/loadingStills.ts";
import { agentsGuideUrl, fmtNum, hallRows, HERO_FADE_MS, HERO_HOLD_MS, heroLive, heroStills, namesLine, newsTiles, progressView, visitsLine, WORLD_STILL, worldCards, type MeInfo } from "./homeModel.ts";
import { onLandingShown } from "./landing.ts";
import { startOrrery, wantsOrrery, type Orrery } from "./orrery.ts";
import { takeHomeNotice, type HomeNotice } from "./leave.ts";
import { signOutSession } from "./signOut.ts";
import { ANALYTICS_OPT_OUT_KEY, privacyText } from "./datafast.ts";

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
  const live = $("home-live");
  const liveText = heroLive(online);
  if (live) {
    live.hidden = !liveText;
    live.replaceChildren();
    if (liveText) {
      el("i", "fl-live-dot", live).setAttribute("aria-hidden", "true");
      el("span", "", live, liveText);
    }
  }
  list.replaceChildren();
  for (const w of worldCards(online)) {
    const li = el("li", `is-${w.id}`, list);
    el("i", "dot", li).setAttribute("aria-hidden", "true");
    el("span", "w", li, w.name);
    el("b", `n num${w.players ? "" : " is-zero"}`, li, online ? fmtNum(w.players) : "–");
    el("span", "who", li, online ? namesLine(online.bodies[w.id].names, w.players) : "…");
  }
}

const STILL_BY_ID = new Map(STILLS.map((s) => [s.id, s]));

/** The four worlds (D-home-10): an in-game still, the world's line, its levels and boss, and who is there now. */
export function renderWorlds(online: HomeOnline | null): void {
  const box = $("home-worlds");
  if (!box) return;
  // The stills stay put between polls (no reload flicker): only the live parts are rewritten.
  const cards = worldCards(online);
  if (box.childElementCount !== cards.length) {
    box.replaceChildren();
    for (const w of cards) {
      const card = el("article", `fl-panel fl-panel--quiet fl-home__world fl-home__worldc--${w.id}`, box);
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", w.name);
      card.dataset.world = w.id;
      const pic = el("div", "fl-home__wpic", card);
      const still = STILL_BY_ID.get(WORLD_STILL[w.id]);
      if (still) {
        const img = el("img", "", pic);
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.width = 1920;
        img.height = 1080;
        if (still.focus) img.style.objectPosition = still.focus;
        img.src = still.src;
      }
      const top = el("div", "fl-home__wtop", pic);
      el("i", `fl-planet fl-planet--${w.id}`, top).setAttribute("aria-hidden", "true");
      const t = el("div", "", top);
      el("h3", "", t, w.name);
      el("small", "", t, w.levels);
      const body = el("div", "fl-home__wbody", card);
      el("p", "fl-home__wline", body, w.line);
      el("p", "fl-home__blurb", body, w.blurb);
      const meta = el("div", "fl-home__wmeta", body);
      if (w.boss) {
        const b = el("span", "", meta);
        sprite("crown", "", b);
        b.append(`${w.boss.name} · Lv ${w.boss.level}`);
      } else {
        const sh = el("span", "", meta);
        icon("shield", "", sh);
        sh.append("Safe inside the walls");
      }
      el("div", "fl-home__wnow", body);
    }
  }
  for (const w of cards) {
    const now = box.querySelector<HTMLElement>(`[data-world="${w.id}"] .fl-home__wnow`);
    if (!now) continue;
    now.replaceChildren();
    now.classList.toggle("is-empty", !w.players);
    el("i", w.players ? "fl-live-dot" : "fl-home__nodot", now).setAttribute("aria-hidden", "true");
    el("b", "num", now, online ? fmtNum(w.players) : "–");
    el("span", "", now, online ? (w.players ? ` here: ${namesLine(online.bodies[w.id].names, w.players)}` : " here right now") : " here");
  }
}

/** "New in the worlds": spells, the hunt (with its public state from the Hall of Firsts) and the starters. */
export function renderNews(board: HomeBoard | null): void {
  const box = $("home-new");
  if (!box) return;
  box.replaceChildren();
  for (const t of newsTiles(board?.hall ?? null)) {
    const tile = el("article", `fl-panel fl-panel--quiet fl-home__tile is-${t.id}`, box);
    const icons = el("div", "fl-home__ticons", tile);
    icons.setAttribute("aria-hidden", "true");
    for (const i of t.icons) {
      const cell = el("span", "", icons);
      sprite(i.sprite, "", el("span", "fl-home__ticon", cell));
      el("small", "", cell, i.label);
    }
    el("h3", "", tile, t.title);
    el("p", "", tile, t.text);
    if (t.state) {
      const st = el("div", `fl-home__tstate${t.claimed ? " is-claimed" : ""}`, tile);
      st.dataset.e2e = "home-hunt-state";
      sprite(t.claimed ? "trophy" : "lock", "", st);
      el("span", "", st, t.state);
    }
  }
}

// ------------------------------------------------------------------------------------- hero stills

export interface HeroStillsOptions {
  holdMs?: number;
  fadeMs?: number;
  /** Reduced motion: the first still stays, nothing cycles. */
  still?: boolean;
  /** The page is on screen (not under the loader, not a hidden tab): only then does the next still load. */
  visible?: () => boolean;
  /**
   * Subscribe to changes of `visible` (the landing page shown or hidden, the tab hidden or back);
   * returns the unsubscribe. With it a hidden hero parks with no timer and wakes on the call;
   * without it, it looks again every second.
   */
  wake?: (fn: () => void) => () => void;
  /** Load an image (resolves false when it fails): injected in tests. */
  load?: (src: string) => Promise<boolean>;
  caption?: HTMLElement | null;
}

const loadImage = (src: string) =>
  new Promise<boolean>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });

/**
 * The hero's slow cross-fade (D-home-9). `box` already holds the first still (index.html); each next
 * one is downloaded only when its turn comes and the page is on screen, then faded in over the old
 * one, which is removed when the fade ends. A still that fails to load is skipped. Returns stop().
 */
export function startHeroStills(box: HTMLElement, stills: readonly Still[], opts: HeroStillsOptions = {}): () => void {
  const hold = opts.holdMs ?? HERO_HOLD_MS;
  const fade = opts.fadeMs ?? HERO_FADE_MS;
  const load = opts.load ?? loadImage;
  const cap = opts.caption ?? null;
  const say = (s: Still | undefined) => {
    if (cap && s) cap.textContent = `${s.caption} · in-game`;
  };
  say(stills[0]);
  if (opts.still || stills.length < 2) return () => {};
  let i = 0;
  let stopped = false;
  let timer = 0;
  /** Hidden with a `wake` to bring it back: no timer runs. */
  let parked = false;
  const next = async () => {
    timer = 0;
    if (stopped) return;
    if (opts.visible && !opts.visible()) {
      if (opts.wake) parked = true;
      else timer = window.setTimeout(next, 1000);
      return;
    }
    i = (i + 1) % stills.length;
    const s = stills[i]!;
    const ok = await load(s.src);
    if (stopped) return;
    if (ok) {
      const old = [...box.querySelectorAll("img")];
      const img = el("img", "", box);
      img.alt = "";
      img.decoding = "async";
      if (s.focus) img.style.objectPosition = s.focus;
      img.src = s.src;
      // Next frame: the new still starts transparent, then fades in over the old one.
      requestAnimationFrame(() => {
        img.classList.add("is-on");
        for (const o of old) o.classList.remove("is-on");
      });
      window.setTimeout(() => {
        for (const o of old) o.remove();
      }, fade + 100);
      say(s);
    }
    timer = window.setTimeout(next, ok ? hold : 200);
  };
  timer = window.setTimeout(next, hold);
  const unwake = opts.wake?.(() => {
    if (stopped || !parked || (opts.visible && !opts.visible())) return;
    parked = false; // on screen again: the next still after a full hold
    timer = window.setTimeout(next, hold);
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    unwake?.();
  };
}

/** The Agents guide button: a link into the public repo, hidden until the repo is public. */
function agentsLink(): void {
  const a = $<HTMLAnchorElement>("home-agents-link");
  if (!a) return;
  a.hidden = !config.publicRepo;
  if (config.publicRepo) a.href = agentsGuideUrl(config.repoUrl);
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
    board.levels.forEach((r, i) => boardRow(list, { rank: i + 1, sprite: portraitSprite(r.starter, r.look), name: r.name, tag: r.title, val: `Lv ${r.level}` }));
    if (!board.levels.length) el("p", "fl-home__empty", body, "No one has made the board yet. Pick a name, play a little, and it's yours.");
  } else if (tab === "medals") {
    board.medals.forEach((r, i) => boardRow(list, { rank: i + 1, sprite: "medal", name: r.name, tag: r.title, val: fmtNum(r.medals), unit: r.medals === 1 ? " medal" : " medals" }));
    if (!board.medals.length) el("p", "fl-home__empty", body, "No medals yet. The first one is for finishing the tutorial.");
  } else {
    for (const r of hallRows(board.hall)) boardRow(list, { sprite: r.name ? "trophy" : "lock", name: r.label, tag: r.name ? `by ${r.name}` : null, val: r.date ?? "Unclaimed", open: !r.name });
  }
}

/**
 * "● N online now" (DataFast, or our own player count without it), and nothing else on that line
 * (#12, owner 2026-10-18). Total visits sit apart in the footer (a stand-in for DataFast's stats
 * card, D-fixes-3); the analytics disclosure is the footer's Privacy card.
 */
export function renderVisits(visits: HomeVisits | null, ourOnline: number | null): void {
  const box = $("home-visits");
  if (!box) return;
  const line = visitsLine(visits, ourOnline);
  box.hidden = !line;
  let total = $("home-total");
  if (!line) {
    if (total) total.hidden = true;
    return;
  }
  box.replaceChildren();
  el("i", "fl-live-dot", box).setAttribute("aria-hidden", "true");
  const on = el("span", "", box);
  el("b", "num", on, line.online);
  on.append(" online now");
  if (line.total !== null) {
    if (!total) {
      total = el("div", "fl-home__total", box.parentElement ?? box);
      total.id = "home-total";
      box.after(total);
    }
    total.hidden = false;
    total.replaceChildren("Total visits ");
    el("b", "num", total, line.total);
  } else if (total) total.hidden = true;
  privacyLink();
}

/** The footer's "Privacy" link (only with DataFast in the page): a short card on its analytics and the opt-out (#12). */
function privacyLink(): void {
  const text = privacyText(config.datafast);
  const credit = document.querySelector(".fl-home__credit");
  if (!text || !credit || document.getElementById("home-privacy")) return;
  const b = button("Privacy", "fl-link fl-home__privacy", credit as HTMLElement, () => openPrivacy(text));
  b.id = "home-privacy";
  b.dataset.e2e = "home-privacy";
}

function openPrivacy(text: string[]): void {
  const d = el("dialog", "fl-panel fl-privacy", document.body) as HTMLDialogElement;
  d.setAttribute("aria-labelledby", "privacy-title");
  el("h2", "", d, "Privacy").id = "privacy-title";
  for (const line of text) el("p", "", d, line);
  const out = (): boolean => {
    try { return localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === "1"; } catch { return false; }
  };
  const row = el("div", "fl-privacy__row", d);
  const toggle = button("", "fl-btn fl-btn--sm", row, () => {
    try {
      if (out()) localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
      else localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    } catch { /* storage unavailable: nothing to remember */ }
    paint();
  });
  const state = el("span", "fl-privacy__state", row);
  const paint = () => {
    toggle.textContent = out() ? "Count my visits again" : "Don't count my visits";
    state.textContent = out() ? "This browser is opted out." : "";
  };
  paint();
  button("Close", "fl-btn fl-btn--sm fl-btn--ghost", row, () => d.close());
  d.addEventListener("close", () => d.remove());
  d.showModal();
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
  const v = has ? progressView(me!, Number(localStorage.getItem("fl.starter") ?? 0) || 0, Number(localStorage.getItem("fl.look") ?? 0) || 0) : null;
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
    // The server emails a code to a new address only from level 2 (D34); it says so in `saveReady`.
    save.disabled = !!v && !(me?.saveReady ?? v.level >= 2);
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
  sprite(portraitSprite(v.starter, v.look), "", face);
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
    // saveStatus() never creates a session: "none" is no session yet (or ?offline). Dev guests read /me as before.
    if (!auth.isDevGuest() && (await auth.saveStatus()) === "none") return null;
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

  // The orrery menu (D-menu-1): the sky over this page, when the visit gets it (home/orrery.ts).
  let orrery: Orrery | null = null;
  const paintData = () => {
    orrery?.setData(data);
    renderOnline(data?.online ?? null);
    renderWorlds(data?.online ?? null);
    renderNews(data?.board ?? null);
    if (data) renderBoard(data.board, tab);
    renderVisits(data?.visits ?? null, data ? data.online.total : null);
  };
  const actions: MeActions = { save: () => void saveProgress(), signOut: () => void signOut() };
  const paintMe = () => {
    renderMe(state, actions);
    orrery?.setMe(state.me);
  };
  if (landing && wantsOrrery()) {
    orrery = startOrrery(landing, { play: () => $("play")?.click(), signIn: () => $("signin")?.click(), signOut: () => void signOut(), save: () => void saveProgress() });
  }
  // Lookups can overlap (the first load, another tab's broadcast, a save): only the newest one paints.
  let meSeq = 0;
  const refreshMe = async () => {
    const seq = ++meSeq;
    const me = await fetchMe();
    if (seq !== meSeq) return;
    state.me = me;
    paintMe();
  };

  async function saveProgress() {
    // The save card (5c): it checks the session and the server first, and opens on "Saving is
    // temporarily unavailable" or "Play a little first" instead of an email field that leads nowhere.
    const { openSaveProgress } = await import("../ui/account.ts");
    const v = state.me ? progressView(state.me) : null;
    const r = await openSaveProgress({ name: v?.name, level: v?.level, starter: v?.starter, look: v?.look });
    if (r === "saved") await refreshMe();
  }

  $("signin")?.addEventListener("click", async () => {
    // A returning player on a new browser (5b): a guest session here merges into the account.
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
      for (const k of ["fl.starter", "fl.palette", "fl.look", "fl.body"]) localStorage.removeItem(k);
      state.notice = null;
      meSeq++; // a lookup still in flight must not bring the signed-out account back
      state.me = null;
    }
    paintMe(); // on failure the account stays, with the error and a retry
  }
  $("signout")?.addEventListener("click", () => void signOut());

  paintData();
  paintMe();
  agentsLink();
  const stillsBox = $("home-stills");
  if (stillsBox) {
    // Runs for the page's life; parked (no timer) while the landing page or the tab is hidden.
    startHeroStills(stillsBox, heroStills(STILLS), {
      still: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      visible: () => !document.hidden && landingVisible(),
      wake: (fn) => {
        const offLanding = onLandingShown(() => fn());
        document.addEventListener("visibilitychange", fn);
        return () => {
          offLanding();
          document.removeEventListener("visibilitychange", fn);
        };
      },
      caption: $("home-still-cap"),
    });
  }
  const poll = async () => {
    if (document.hidden || !landingVisible()) return;
    const next = await fetchHome();
    if (next) {
      data = next;
      paintData();
    } else if (!data) renderBoard(null, tab); // the server is unreachable: say so instead of an empty card
  };
  void poll();
  let pollTimer = window.setInterval(() => void poll(), POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
  // Under the loading screen the page is out (landing.ts, D-home-8): no polling. Back on the home page
  // (a failed load): fresh data at once, then the usual rhythm.
  onLandingShown((shown) => {
    orrery?.setShown(shown);
    clearInterval(pollTimer);
    if (!shown) return;
    void poll();
    void refreshMe();
    pollTimer = window.setInterval(() => void poll(), POLL_MS);
  });
  // Another tab saved, signed in or renamed: repaint my progress and the guest's Save button from a
  // fresh session lookup (fetchMe asks the session; the broadcast already dropped the cached token).
  // Listening before the first lookup, so a change while it runs isn't missed.
  const auth = await import("../net/auth.ts");
  auth.onAccountChange((_claims, { elsewhere }) => {
    if (elsewhere) void refreshMe();
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
  renderNews(data.board);
  const cap = $("home-still-cap");
  if (cap) cap.textContent = `${heroStills(STILLS)[0]?.caption ?? ""} · in-game`;
  renderBoard(data.board, "levels");
  renderVisits(data.visits, data.online.total);
  renderMe({ me, notice });
}

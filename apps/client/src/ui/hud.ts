// In-game HUD (verdict: Entry B): player card (HP, XP, level, coins), hotbar + ammo, crosshair + hit
// marker, damage numbers, hurt/low-HP vignette, toasts and missions (one column), zone banner, logout
// countdown, pickup prompt, speech bubbles, boss bar and party frames. Plain DOM (D25).
// Every setter caches what it last wrote, so per-frame calls (setHp, setSafe, setLogout, setPrompt…)
// touch the DOM only when a value changes; nothing in here reads layout.

import "./hud.css";
import "./styles/compat.css";
import "./styles/kit.css";
import { STARTERS, PALETTE_NAMES, WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { PHRASES, type YouState } from "@firstlight/shared/net/protocol";
import { el, icon, sprite, uiRoot } from "./dom.ts";
import { formatDamage, isLowHp, parsePrompt, slotView, type DamageKind, type SlotView } from "./hudFormat.ts";
import { installSprites, portraitSprite } from "./sprites.ts";
import { uiSettings, type UiSettings } from "./uiSettings.ts";
import { showSubtitle } from "./subtitle.ts";
import { showCharacterPick, type CharacterPickOptions } from "./characterPick.ts";
import { showDeath, type DeathInfo } from "./death.ts";

export type YouPlus = YouState & { selected: number; level: number; dead: boolean };
export type { DamageKind } from "./hudFormat.ts";
export type { DeathInfo } from "./death.ts";
export type { CharacterPickOptions } from "./characterPick.ts";

/** Boss bar (NPC lane): red hatched for monsters, slate + amber monospaced for Meridian Oversight. */
export interface BossBarState {
  name: string;
  hp: number;
  max: number;
  level?: number;
  phase?: number;
  phaseName?: string;
  variant?: "monster" | "oversight";
  /** Phase thresholds as fractions of max HP, e.g. [0.6, 0.25]. */
  notches?: number[];
  /** Left footer text, e.g. "3 in the arena". */
  note?: string;
}

/** Party frame (social lane). Slot 1 is you; the slot number always shows next to the colour. */
export interface PartyMember {
  slot: 1 | 2 | 3 | 4;
  name: string;
  level: number;
  starter: number;
  hp: number;
  maxHp: number;
  speaking?: boolean;
  radio?: boolean;
  muted?: boolean;
  /** Metres, or null when on another body. */
  distance?: number | null;
  title?: string;
}

export interface MissionLine {
  id: string;
  title: string;
  detail: string;
  /** Right column: "3/8", "380 m", "Done". */
  progress: string;
  state?: "open" | "tracked" | "done";
}

export interface ToastOptions {
  /** Small caps kicker above the text, e.g. "Medal unlocked". */
  title?: string;
  /** Second line under the text. */
  sub?: string;
  /** Sprite name (sprites.ts); defaults by kind. */
  sprite?: string;
  ms?: number;
}

const TOAST_SPRITE: Record<string, string | undefined> = { xp: "star", coins: "coin", medal: "medal", warn: "alert", mission: "flag", info: undefined };
const PHRASE_SPRITE = ["flag", "alert", "arrow", "crown", "heart", "trophy"];
const LOGOUT_MS = 30_000; // server RULES.LOGOUT_MS
const RING_C = 106.8; // 2π × 17 (logout ring circumference)
const MAX_DAMAGE_NUMBERS = 24;
const MAX_TOASTS = 5;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

interface SlotRefs {
  root: HTMLDivElement;
  sprite: HTMLElement;
  tier: HTMLElement;
  corner: HTMLElement;
  lock: HTMLElement;
  key: string;
}

export class Hud {
  readonly root = el("div", "fl-hud");
  private readonly world = el("div", "fl-hud__world", this.root);
  private readonly vignette = el("div", "fl-vignette", this.root);
  private readonly layer = el("div", "fl-hud__layer", this.root);

  private readonly cross = el("div", "fl-cross", this.layer);
  private readonly hitmark = el("div", "fl-hitmark", this.layer);

  private readonly top = el("div", "fl-hud__top", this.layer);
  private banner: HTMLElement | null = null;
  private readonly boss = el("section", "fl-boss", this.top);

  readonly party = el("section", "fl-party", this.layer);
  private readonly right = el("div", "fl-hud__right", this.layer);
  private readonly missions = el("section", "fl-missions fl-holo fl-corners", this.right);
  private readonly toasts = el("div", "fl-toasts", this.right);

  private readonly mid = el("div", "fl-hud__mid", this.layer);
  private readonly prompt = el("div", "fl-prompt fl-holo", this.mid);
  private readonly logout = el("div", "fl-logout fl-holo", this.mid);

  private readonly me = el("section", "fl-me fl-holo", this.layer);
  private readonly hotbarWrap = el("div", "fl-hotbar-wrap", this.layer);
  /** Bottom-right slot for the voice lane (own mic state, people in earshot). */
  readonly voiceSlot = el("div", "fl-hud__br", this.layer);

  // player card refs
  private faceSprite!: HTMLElement;
  private lvlEl!: HTMLElement;
  private nameEl!: HTMLElement;
  private subEl!: HTMLElement;
  private safeChip!: HTMLElement;
  private coinsEl!: HTMLElement;
  private hpRow!: HTMLElement;
  private hpFill!: HTMLElement;
  private hpTrail!: HTMLElement;
  private hpVal!: HTMLElement;
  private hpMax!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpVal!: HTMLElement;
  // hotbar refs
  private readonly slots: SlotRefs[] = [];
  private wname!: HTMLElement;
  private ammo!: HTMLElement;
  private ammoN!: HTMLElement;
  private ammoMax!: HTMLElement;
  // logout + prompt refs
  private logoutRing!: SVGCircleElement;
  private logoutN!: HTMLElement;
  private promptKey!: HTMLElement;
  private promptText!: HTMLElement;
  // boss refs
  private bossName!: HTMLElement;
  private bossLv!: HTMLElement;
  private bossPhase!: HTMLElement;
  private bossFill!: HTMLElement;
  private bossTrail!: HTMLElement;
  private bossBarEl!: HTMLElement;
  private bossNote!: HTMLElement;
  private bossHp!: HTMLElement;

  // last written values (batching)
  private c = {
    hp: -1, max: -1, low: false, safe: null as boolean | null, logout: -2, prompt: "\u0000", level: -1, coins: -1,
    xp: "", wname: "", ammo: "", ranged: null as boolean | null, identity: "", selected: -1,
    boss: "", bossFill: -1, bossNotches: "", party: "", missions: "",
  };
  private name = "";
  private starter = 0;
  private palette = 0;
  private settings: UiSettings = uiSettings.get();
  private liveDamage = 0;
  you: YouPlus | null = null;
  /** The last `you` seen alive: what the death screen lists as left in the pile. */
  lastAlive: YouPlus | null = null;

  constructor() {
    installSprites();
    this.root.dataset.hud = "";
    const host = uiRoot();
    if (!host.classList.contains("fl-ui")) this.root.classList.add("fl-ui");
    host.appendChild(this.root);
    this.vignette.setAttribute("aria-hidden", "true");
    this.buildCross();
    this.buildBoss();
    this.buildMe();
    this.buildHotbar();
    this.buildMid();
    this.missions.hidden = true;
    this.toasts.setAttribute("aria-live", "polite");
    this.starter = Number(localStorage.getItem("fl.starter") ?? 0) || 0;
    this.palette = Number(localStorage.getItem("fl.palette") ?? 0) || 0;
    this.applySettings(this.settings);
    uiSettings.onChange((s) => this.applySettings(s));
  }

  // ---------------------------------------------------------------------------------------------- build

  private buildCross() {
    for (const k of ["c", "h l", "h r", "v t", "v b"]) el("i", k, this.cross);
    for (const k of ["a", "b", "c", "d"]) el("i", k, this.hitmark);
    this.cross.setAttribute("aria-hidden", "true");
    this.hitmark.setAttribute("aria-hidden", "true");
  }

  private buildBoss() {
    this.boss.hidden = true;
    this.boss.setAttribute("aria-label", "Boss health");
    const row = el("div", "fl-boss__row", this.boss);
    const name = el("div", "fl-boss__name", row);
    el("i", "fl-hex", name);
    this.bossName = el("span", "", name);
    this.bossLv = el("span", "fl-boss__lv", name);
    this.bossPhase = el("div", "fl-boss__phase", row);
    this.bossBarEl = el("div", "fl-boss__bar", this.boss);
    this.bossTrail = el("i", "fl-boss__trail", this.bossBarEl);
    this.bossFill = el("i", "fl-boss__fill", this.bossBarEl);
    const foot = el("div", "fl-boss__foot", this.boss);
    this.bossNote = el("span", "", foot);
    this.bossHp = el("span", "num", foot);
  }

  private buildMe() {
    this.me.setAttribute("aria-label", "You");
    const id = el("div", "fl-me__id", this.me);
    const face = el("div", "fl-face", id);
    this.faceSprite = sprite(portraitSprite(0), "", face);
    this.lvlEl = el("span", "fl-lvl num", face, "1");
    const who = el("div", "fl-me__who", id);
    this.nameEl = el("b", "", who, "You");
    const sub = el("span", "", who);
    this.subEl = el("span", "", sub, "");
    this.safeChip = el("span", "fl-chip fl-chip--photon fl-me__safe", sub, "Safe");
    this.safeChip.hidden = true;
    const purse = el("div", "fl-me__purse num", id);
    sprite("coin", "", purse);
    this.coinsEl = el("span", "", purse, "0");

    this.hpRow = el("div", "fl-hp", this.me);
    sprite("heart", "", this.hpRow);
    const bar = el("div", "fl-hpbar", this.hpRow);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", "Health");
    this.hpTrail = el("i", "trail", bar);
    this.hpFill = el("i", "fill", bar);
    const val = el("span", "fl-hp__val num", this.hpRow);
    this.hpVal = el("b", "", val, "100");
    el("em", "", val, "!");
    const small = el("small", "", val, " / ");
    this.hpMax = el("span", "", small, "100");

    const xp = el("div", "fl-xprow", this.me);
    el("span", "k", xp, "XP");
    const xb = el("div", "fl-xpbar", xp);
    this.xpFill = el("i", "", xb);
    this.xpVal = el("span", "v num", xp, "0 / 0");
  }

  private buildHotbar() {
    const bar = el("div", "fl-hotbar", this.hotbarWrap);
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Hotbar");
    this.wname = el("div", "fl-wname", bar);
    for (let i = 0; i < 4; i++) {
      const root = el("div", "fl-slot fl-arcade is-empty", bar);
      el("span", "fl-slot__k", root, String(i + 1));
      const sp = sprite("fists", "", root);
      const tier = el("span", "fl-tier", root);
      const corner = el("span", "fl-slot__q num", root);
      const lock = sprite("lock", "fl-slot__lock", root);
      lock.hidden = true;
      this.slots.push({ root, sprite: sp, tier, corner, lock, key: "" });
    }
    this.ammo = el("div", "fl-ammo", this.hotbarWrap);
    const n = el("div", "fl-ammo__n num", this.ammo);
    this.ammoN = el("span", "", n);
    this.ammoMax = el("small", "", n);
    const r = el("div", "fl-ammo__r", this.ammo);
    el("span", "fl-key", r, "R");
    r.append("Reload");
    this.ammo.hidden = true;
  }

  private buildMid() {
    this.prompt.hidden = true;
    this.promptKey = el("span", "fl-key fl-key--lit", this.prompt);
    this.promptText = el("b", "", this.prompt);

    this.logout.hidden = true;
    this.logout.setAttribute("role", "status");
    const ring = el("div", "fl-ring num", this.logout);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    const bg = document.createElementNS(svgNs, "circle");
    const fg = document.createElementNS(svgNs, "circle");
    for (const c of [bg, fg]) {
      c.setAttribute("cx", "20");
      c.setAttribute("cy", "20");
      c.setAttribute("r", "17");
    }
    bg.setAttribute("class", "bg");
    fg.setAttribute("class", "fg");
    svg.append(bg, fg);
    ring.appendChild(svg);
    this.logoutRing = fg;
    this.logoutN = el("span", "", ring, "30");
    const text = el("div", "", this.logout);
    el("b", "", text, "Logging out");
    el("span", "", text, "Stay still. Moving, attacking or taking damage cancels.");
  }

  // ---------------------------------------------------------------------------------------------- settings

  applySettings(s: UiSettings) {
    this.settings = s;
    this.root.classList.toggle("is-classic-dmg", !s.cbDamage);
  }

  // ---------------------------------------------------------------------------------------------- player state

  setYou(you: YouPlus) {
    this.you = you;
    if (!you.dead) this.lastAlive = you;
    const c = this.c;
    if (you.level !== c.level) this.lvlEl.textContent = String((c.level = you.level));
    if (you.coins !== c.coins) this.coinsEl.textContent = fmt((c.coins = you.coins));
    const xpKey = `${you.xp}/${you.xpToNext}`;
    if (xpKey !== c.xp) {
      c.xp = xpKey;
      const f = you.xpToNext > 0 ? Math.min(1, Math.max(0, you.xp / you.xpToNext)) : 1;
      this.xpFill.style.setProperty("--fill", f.toFixed(4));
      this.xpVal.textContent = you.xpToNext > 0 ? `${fmt(you.xp)} / ${fmt(you.xpToNext)}` : "Max level";
    }
    let selectedView: SlotView | null = null;
    you.hotbar.forEach((it, i) => {
      const view = slotView(it, you.level);
      if (i === you.selected) selectedView = view;
      this.renderSlot(this.slots[i]!, view, i === you.selected);
    });
    const sel = selectedView as SlotView | null;
    const wname = sel?.name ?? "Fists";
    if (wname !== c.wname) this.wname.textContent = c.wname = wname;
    const ammo = sel?.ammo ? `${sel.ammo.cur}/${sel.ammo.max}` : "";
    if (ammo !== c.ammo) {
      c.ammo = ammo;
      this.ammo.hidden = !sel?.ammo;
      if (sel?.ammo) {
        this.ammoN.textContent = String(sel.ammo.cur);
        this.ammoMax.textContent = `/ ${sel.ammo.max}`;
        this.ammo.classList.toggle("is-low", sel.ammo.cur <= Math.ceil(sel.ammo.max / 4));
      }
    }
    const item = you.hotbar[you.selected];
    const ranged = !!item && WEAPON_BY_ID.get(item.id)?.delivery !== "melee";
    if (ranged !== c.ranged) this.cross.classList.toggle("is-melee", !(c.ranged = ranged));
  }

  private renderSlot(s: SlotRefs, v: SlotView, selected: boolean) {
    const key = `${v.sprite}|${v.tier}|${v.corner}|${v.gated}|${v.empty}|${selected}`;
    if (key === s.key) return;
    s.key = key;
    s.root.classList.toggle("is-on", selected);
    s.root.classList.toggle("fl-arcade--lit", selected);
    s.root.classList.toggle("is-gated", v.gated);
    s.root.classList.toggle("is-empty", v.empty);
    s.root.title = v.name;
    s.sprite.className = `px px-${v.sprite}`;
    s.tier.replaceChildren();
    s.tier.hidden = v.tier === 0;
    for (let t = 1; t <= 3 && v.tier > 0; t++) el("i", t <= v.tier ? "on" : "", s.tier);
    s.tier.setAttribute("aria-label", v.tier ? `Tier ${v.tier}` : "");
    s.corner.textContent = v.corner;
    s.lock.hidden = !v.gated;
  }

  /** Name and look shown on the player card (from the room state; cheap to call every frame). */
  setIdentity(name: string, starter: number, palette: number) {
    const key = `${name}|${starter}|${palette}`;
    if (key === this.c.identity) return;
    this.c.identity = key;
    this.name = name;
    this.starter = starter;
    this.palette = palette;
    this.nameEl.textContent = name || "You";
    this.faceSprite.className = `px px-${portraitSprite(starter)}`;
    this.subEl.textContent = `${STARTERS[starter]?.name ?? ""} · ${PALETTE_NAMES[palette] ?? ""}`;
  }

  setHp(hp: number, max: number) {
    const c = this.c;
    if (hp === c.hp && max === c.max) return;
    c.hp = hp;
    c.max = max;
    const f = Math.max(0, Math.min(1, hp / Math.max(1, max)));
    this.hpFill.style.setProperty("--fill", f.toFixed(4));
    this.hpTrail.style.setProperty("--fill", f.toFixed(4));
    this.hpVal.textContent = String(Math.max(0, Math.ceil(hp)));
    this.hpMax.textContent = String(max);
    const low = isLowHp(hp, max);
    if (low !== c.low) {
      c.low = low;
      this.hpRow.classList.toggle("is-low", low);
      this.vignette.classList.toggle("is-low", low);
    }
  }

  setSafe(on: boolean) {
    const prev = this.c.safe;
    if (on === prev) return;
    this.c.safe = on;
    this.safeChip.hidden = !on;
    if (prev === null && !on) return; // spawned outside: nothing was left
    this.showBanner(on);
  }

  private showBanner(safe: boolean) {
    this.banner?.remove();
    const b = el("div", `fl-banner fl-holo ${safe ? "is-safe" : "is-pvp"}`);
    if (safe) icon("shield", "", b);
    b.append(safe ? "Safe zone" : "Leaving safe zone");
    el("small", "", b, safe ? "No damage in or out" : "Anyone can hurt you");
    this.top.prepend(b);
    this.banner = b;
    window.setTimeout(() => {
      if (this.banner === b) this.banner = null;
      b.remove();
    }, 2500);
  }

  setLogout(endsAt: number | null, serverNow: number) {
    const left = endsAt ? Math.max(0, endsAt - serverNow) : -1;
    const secs = left < 0 ? -1 : Math.ceil(left / 1000);
    if (secs === this.c.logout) return;
    this.c.logout = secs;
    this.logout.hidden = secs < 0;
    if (secs < 0) return;
    this.logoutN.textContent = String(secs);
    this.logoutRing.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, left / LOGOUT_MS)));
  }

  /** True when some system already put up an interaction prompt this frame (prompts are set each frame). */
  get promptShown(): boolean {
    return this.c.prompt !== "" && this.c.prompt !== "\u0000";
  }

  /** Interaction prompt. "E — take everything…" shows E as a keycap; or pass the key separately. */
  setPrompt(text: string | null, key?: string | null) {
    const k = text ? `${key ?? ""}\u0001${text}` : "";
    if (k === this.c.prompt) return;
    this.c.prompt = k;
    this.prompt.hidden = !text;
    if (!text) return;
    const p = parsePrompt(text, key);
    this.promptKey.hidden = !p.key;
    this.promptKey.textContent = p.key ?? "";
    this.promptText.textContent = p.text;
  }

  // ---------------------------------------------------------------------------------------------- combat feedback

  hit(weak: boolean) {
    this.hitmark.classList.toggle("is-weak", weak);
    this.hitmark.animate(
      [
        { opacity: 1, transform: "rotate(45deg) scale(1.2)" },
        { opacity: 1, transform: "rotate(45deg) scale(1)", offset: 0.4 },
        { opacity: 0, transform: "rotate(45deg) scale(1)" },
      ],
      { duration: weak ? 260 : 200, easing: "ease-out" },
    );
  }

  /** Red edge flash when we take damage (low HP keeps a heartbeat on top). */
  hurt() {
    this.vignette.animate([{ opacity: 0.9 }, { opacity: this.c.low ? 1 : 0 }], { duration: 450, easing: "ease-out" });
  }

  /** Floating damage number at screen (x, y). `kind` overrides `weak` (armour / shield / heal). */
  damageNumber(x: number, y: number, amount: number, weak: boolean, kind?: DamageKind) {
    if (!this.settings.damageNumbers || this.liveDamage >= MAX_DAMAGE_NUMBERS) return;
    const f = formatDamage(amount, kind ?? (weak ? "weak" : "normal"));
    const d = el("span", f.cls, this.world, f.text);
    d.style.setProperty("--x", `${Math.round(x)}px`);
    d.style.setProperty("--y", `${Math.round(y)}px`);
    this.liveDamage++;
    d.addEventListener("animationend", () => {
      d.remove();
      this.liveDamage--;
    }, { once: true });
  }

  // ---------------------------------------------------------------------------------------------- toasts, bubbles, subtitles

  /** Returns the toast element (e.g. for a `data-e2e` hook). */
  toast(text: string, kind = "info", opts: ToastOptions = {}): HTMLElement {
    const lit = kind === "medal";
    const t = el("div", `fl-toast fl-arcade${lit ? " fl-arcade--lit" : ""} is-${kind}`, this.toasts);
    const sp = opts.sprite ?? TOAST_SPRITE[kind];
    if (sp) sprite(sp, "", t);
    const body = el("div", "", t);
    if (opts.title) el("div", "fl-toast__k", body, opts.title);
    const tt = el("div", "fl-toast__t", body, text);
    if (opts.sub) el("small", "", tt, opts.sub);
    // Newest on top.
    this.toasts.prepend(t);
    while (this.toasts.children.length > MAX_TOASTS) this.toasts.lastElementChild?.remove();
    const ms = opts.ms ?? (kind === "medal" ? 5000 : 3500);
    window.setTimeout(() => {
      t.classList.add("is-out");
      window.setTimeout(() => t.remove(), 220);
    }, ms);
    return t;
  }

  /** Speech bubble at screen (x, y) for 3 s. Phrase-wheel lines get their icon. */
  bubble(x: number, y: number, text: string, opts: { name?: string; slot?: 1 | 2 | 3 | 4 } = {}): HTMLElement {
    const b = el("div", `fl-bubble${opts.slot ? " is-party" : ""}`, this.world);
    if (opts.slot) b.style.setProperty("--c", `var(--party-${opts.slot})`);
    b.style.setProperty("--x", `${Math.round(x)}px`);
    b.style.setProperty("--y", `${Math.round(y)}px`);
    const body = el("div", "fl-bubble__body", b);
    const pi = (PHRASES as readonly string[]).indexOf(text);
    if (pi >= 0) sprite(PHRASE_SPRITE[pi]!, "", body);
    body.append(text);
    el("div", "fl-bubble__tail", b);
    if (opts.name) {
      const n = el("div", "fl-bubble__name", b);
      if (opts.slot) el("span", "fl-pip", n, String(opts.slot));
      n.append(opts.name);
    }
    window.setTimeout(() => b.remove(), 3000);
    return b;
  }

  subtitle(speaker: string, text: string, ms = 4500) {
    showSubtitle(speaker, text, ms);
  }

  // ---------------------------------------------------------------------------------------------- boss bar (NPC lane)

  bossBar(s: BossBarState) {
    const key = `${s.name}|${s.level ?? ""}|${s.phase ?? ""}|${s.phaseName ?? ""}|${s.variant ?? "monster"}|${s.note ?? ""}|${s.hp}|${s.max}`;
    if (key !== this.c.boss) {
      this.c.boss = key;
      this.boss.hidden = false;
      this.boss.classList.toggle("is-oversight", s.variant === "oversight");
      this.bossName.textContent = s.name;
      this.bossLv.textContent = s.level ? `Lv ${s.level}` : "";
      this.bossPhase.replaceChildren();
      if (s.phase !== undefined) {
        this.bossPhase.append("Phase ");
        el("b", "", this.bossPhase, String(s.phase));
        if (s.phaseName) this.bossPhase.append(` · ${s.phaseName}`);
      }
      this.bossNote.textContent = s.note ?? "";
      this.bossHp.textContent = `${fmt(Math.max(0, s.hp))} / ${fmt(s.max)}`;
      const f = Math.max(0, Math.min(1, s.hp / Math.max(1, s.max)));
      if (f !== this.c.bossFill) {
        this.c.bossFill = f;
        this.bossFill.style.setProperty("--fill", f.toFixed(4));
        this.bossTrail.style.setProperty("--fill", f.toFixed(4));
      }
    }
    const notches = (s.notches ?? []).join(",");
    if (notches !== this.c.bossNotches) {
      this.c.bossNotches = notches;
      for (const n of this.bossBarEl.querySelectorAll(".fl-boss__notch")) n.remove();
      for (const n of s.notches ?? []) el("span", "fl-boss__notch", this.bossBarEl).style.left = `${(n * 100).toFixed(2)}%`;
    }
  }

  hideBossBar() {
    this.boss.hidden = true;
    this.c.boss = "";
  }

  // ---------------------------------------------------------------------------------------------- party (social lane)

  setParty(members: PartyMember[]) {
    const key = JSON.stringify(members);
    if (key === this.c.party) return;
    this.c.party = key;
    this.party.replaceChildren();
    for (const m of members) {
      const row = el("div", `fl-mate fl-holo${m.speaking ? " is-speaking" : ""}${m.muted ? " is-muted" : ""}`, this.party);
      row.dataset.slot = String(m.slot);
      const av = el("div", "fl-mate__avatar", row);
      sprite(portraitSprite(m.starter), "", av);
      el("span", "fl-pip", av, String(m.slot));
      const body = el("div", "", row);
      const top = el("div", "fl-mate__top", body);
      el("span", "fl-mate__name", top, m.name);
      el("span", "fl-mate__lv num", top, `Lv ${m.level}`);
      const bar = el("div", "fl-bar", body);
      el("i", "", bar);
      bar.style.setProperty("--fill", String(Math.max(0, Math.min(1, m.hp / Math.max(1, m.maxHp)))));
      const meta = el("div", "fl-mate__meta", body);
      if (m.speaking || m.radio) {
        const talk = el("span", "is-talk", meta);
        icon(m.radio ? "radio" : "mic", "", talk);
        talk.append(m.radio ? "Radio" : "Talking");
      } else if (m.muted) {
        const s = el("span", "", meta);
        icon("mic-off", "", s);
        s.append("Muted");
      } else el("span", "", meta, m.title ?? "");
      el("span", "num", meta, m.distance === null ? "elsewhere" : m.distance !== undefined ? `${Math.round(m.distance)} m` : "");
    }
  }

  // ---------------------------------------------------------------------------------------------- missions (quests lane)

  setMissions(lines: MissionLine[], header = "") {
    const key = JSON.stringify([lines, header]);
    if (key === this.c.missions) return;
    this.c.missions = key;
    this.missions.hidden = lines.length === 0;
    this.missions.replaceChildren();
    if (!lines.length) return;
    const h = el("header", "", this.missions);
    el("span", "fl-label", h, "Missions");
    el("span", "", h, header);
    for (const m of lines) {
      const row = el("div", `fl-mission${m.state && m.state !== "open" ? ` is-${m.state}` : ""}`, this.missions);
      el("i", "fl-mission__st", row);
      const d = el("div", "", row);
      el("b", "", d, m.title);
      el("span", "", d, m.detail);
      el("span", "fl-mission__r num", row, m.progress);
    }
  }

  // ---------------------------------------------------------------------------------------------- full-screen flows

  /** Death screen; resolves with the chosen starter and palette for rebirth. */
  death(info: DeathInfo): Promise<{ starter: number; palette: number }> {
    return showDeath(info, {
      name: this.name,
      starter: this.starter,
      lastAlive: this.lastAlive,
      pick: () => this.characterPick({ rebirth: true }),
    });
  }

  /** Starter + palette picker (first play and rebirth). A string argument is the old title form. */
  characterPick(opts: string | CharacterPickOptions = {}): Promise<{ starter: number; palette: number }> {
    return showCharacterPick(typeof opts === "string" ? { title: opts } : opts);
  }

  dispose() {
    this.root.remove();
  }
}


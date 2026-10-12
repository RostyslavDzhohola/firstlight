// In-game HUD: HP/XP/level/coins, hotbar, crosshair + hit marker, safe-zone sign, toasts, logout
// countdown, pickup prompt, damage numbers, death screen and character pick. Plain DOM (D25).

import "./hud.css";
import { STARTERS, PALETTE_NAMES, WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { itemName } from "@firstlight/shared/content/items";
import type { InvItem, YouState } from "@firstlight/shared/net/protocol";
import { config } from "../config.ts";

export type YouPlus = YouState & { selected: number; level: number; dead: boolean };

const PALETTE_SWATCH = ["#f2efe6", "#d8b98a", "#2a2f45", "#5f7a4a", "#c0482e", "#6a4fa0"];
const TIERS = ["", "I", "II", "III"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root = el("div", "fl-hud");
  private readonly cross = el("div", "fl-cross", this.root);
  private readonly hitmark = el("div", "fl-hitmark", this.root);
  private readonly vignette = el("div", "fl-vignette", this.root);
  private readonly safe = el("div", "fl-safe", this.root, "SAFE ZONE");
  private readonly logoutEl = el("div", "fl-logout", this.root);
  private readonly toasts = el("div", "fl-toasts", this.root);
  private readonly prompt = el("div", "fl-prompt", this.root);
  private readonly bottom = el("div", "fl-bottom", this.root);
  private readonly bars = el("div", "fl-bars", this.bottom);
  private readonly lvl = el("div", "fl-lvl", this.bars, "LV 1");
  private readonly hp = el("div", "fl-bar fl-hp", this.bars);
  private readonly hpFill = el("i", "", this.hp);
  private readonly coins = el("div", "fl-coins", this.bars, "0 ◎");
  private readonly xp = el("div", "fl-bar fl-xp", this.bottom);
  private readonly xpFill = el("i", "", this.xp);
  private readonly hotbar = el("div", "fl-hotbar", this.bottom);
  private readonly slots: HTMLDivElement[] = [];
  private hitTimer = 0;
  you: YouPlus | null = null;

  constructor() {
    document.body.appendChild(this.root);
    for (let i = 0; i < 4; i++) {
      const s = el("div", "fl-slot", this.hotbar);
      el("b", "", s, String(i + 1));
      el("div", "n", s, "Fists");
      el("div", "s", s, "");
      this.slots.push(s);
    }
  }

  setYou(you: YouPlus) {
    this.you = you;
    this.lvl.textContent = `LV ${you.level}`;
    this.coins.textContent = `${you.coins} ◎`;
    this.xpFill.style.width = you.xpToNext > 0 ? `${Math.min(100, (you.xp / you.xpToNext) * 100)}%` : "100%";
    you.hotbar.forEach((it, i) => this.renderSlot(this.slots[i]!, it, i === you.selected, you.level));
    const ranged = you.hotbar[you.selected] && WEAPON_BY_ID.get(you.hotbar[you.selected]!.id)?.delivery !== "melee";
    this.cross.classList.toggle("dot", !ranged);
  }

  private renderSlot(s: HTMLDivElement, it: InvItem | null, sel: boolean, level: number) {
    s.classList.toggle("sel", sel);
    const n = s.querySelector(".n")!, st = s.querySelector(".s")!;
    if (!it) {
      n.textContent = "Fists";
      st.textContent = "";
      return;
    }
    const def = WEAPON_BY_ID.get(it.id);
    const tier = def?.tiers[it.tier - 1];
    n.innerHTML = `${itemName(it)} <span class="t">${def && !it.skin ? TIERS[it.tier] : ""}</span>`;
    const parts: string[] = [];
    if (tier?.mag !== undefined) parts.push(`${it.mag ?? tier.mag}/${tier.mag}`);
    if ((def?.stack ?? 1) > 1) parts.push(`×${it.qty}`);
    if (tier && tier.level > level) parts.push(`needs LV ${tier.level}`);
    st.textContent = parts.join("  ");
  }

  setHp(hp: number, max: number) {
    this.hpFill.style.width = `${Math.max(0, Math.min(100, (hp / Math.max(1, max)) * 100))}%`;
    this.vignette.style.opacity = hp / max < 0.3 ? String(0.25 + 0.35 * (1 - hp / max)) : "0";
  }

  setSafe(on: boolean) {
    this.safe.classList.toggle("on", on);
  }

  setLogout(endsAt: number | null, serverNow: number) {
    if (!endsAt) {
      this.logoutEl.classList.remove("on");
      return;
    }
    this.logoutEl.classList.add("on");
    this.logoutEl.textContent = `Logging out in ${Math.max(0, Math.ceil((endsAt - serverNow) / 1000))} s — don't move`;
  }

  setPrompt(text: string | null) {
    this.prompt.classList.toggle("on", !!text);
    if (text) this.prompt.textContent = text;
  }

  hit(weak: boolean) {
    this.hitmark.classList.add("on");
    this.hitmark.classList.toggle("weak", weak);
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hitmark.classList.remove("on"), 140);
  }

  hurt() {
    this.vignette.style.opacity = "0.55";
    setTimeout(() => this.setHp(1, 1), 0);
  }

  damageNumber(x: number, y: number, amount: number, weak: boolean) {
    const d = el("div", `fl-dmg${weak ? " weak" : ""}`, this.root, weak ? `${amount}!` : String(amount));
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    requestAnimationFrame(() => {
      d.style.transform = "translateY(-36px)";
      d.style.opacity = "0";
    });
    setTimeout(() => d.remove(), 700);
  }

  toast(text: string, kind = "info") {
    const t = el("div", `fl-toast ${kind}`, this.toasts, text);
    setTimeout(() => t.remove(), 3500);
    while (this.toasts.children.length > 5) this.toasts.firstElementChild?.remove();
  }

  bubble(x: number, y: number, text: string) {
    const b = el("div", "fl-bubble", this.root, text);
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    setTimeout(() => b.remove(), 3000);
    return b;
  }

  /** Death screen; resolves with the chosen starter and palette for rebirth. */
  death(info: { killerName: string; aliveMs: number; level: number }): Promise<{ starter: number; palette: number }> {
    const mins = Math.floor(info.aliveMs / 60000);
    const secs = Math.floor((info.aliveMs % 60000) / 1000);
    const ov = el("div", "fl-overlay");
    const p = el("div", "fl-panel", ov);
    el("h2", "", p, "YOU DIED");
    el("p", "", p, `Killed by ${info.killerName || "the world"} · lived ${mins}m ${secs}s · reached level ${info.level}`);
    el("p", "", p, "Everything you carried lies where you fell. Anyone can take it — including you.");
    const gh = el("p", "", p);
    gh.innerHTML = `Enjoying FIRSTLIGHT? <a href="${config.repoUrl}" target="_blank" rel="noopener" style="color:#ffd8a8">Star or fork it on GitHub</a>`;
    if (!config.publicRepo) gh.style.display = "none";
    document.body.appendChild(ov);
    document.exitPointerLock?.();
    return new Promise((resolve) => {
      const btn = el("button", "fl-btn", p, "Rise again");
      btn.onclick = async () => {
        ov.remove();
        resolve(await this.characterPick("Choose your next life"));
      };
    });
  }

  characterPick(title = "Choose your character"): Promise<{ starter: number; palette: number }> {
    const ov = el("div", "fl-overlay");
    const p = el("div", "fl-panel", ov);
    el("h2", "", p, title);
    el("p", "", p, "Same body, different look and starting weapon. One life.");
    let starter = Number(localStorage.getItem("fl.starter") ?? 0);
    let palette = Number(localStorage.getItem("fl.palette") ?? 0);
    const grid = el("div", "fl-starters", p);
    const cards = STARTERS.map((s, i) => {
      const c = el("div", `fl-starter${i === starter ? " sel" : ""}`, grid);
      el("div", "", c, s.name).style.fontWeight = "800";
      el("div", "w", c, WEAPON_BY_ID.get(s.weapon)?.name ?? s.weapon);
      c.onclick = () => {
        starter = i;
        cards.forEach((x, j) => x.classList.toggle("sel", j === i));
      };
      return c;
    });
    const pal = el("div", "fl-palettes", p);
    const sw = PALETTE_SWATCH.map((col, i) => {
      const s = el("div", `fl-swatch${i === palette ? " sel" : ""}`, pal);
      s.style.background = col;
      s.title = PALETTE_NAMES[i]!;
      s.onclick = () => {
        palette = i;
        sw.forEach((x, j) => x.classList.toggle("sel", j === i));
      };
      return s;
    });
    document.body.appendChild(ov);
    return new Promise((resolve) => {
      const btn = el("button", "fl-btn", p, "Play");
      btn.onclick = () => {
        localStorage.setItem("fl.starter", String(starter));
        localStorage.setItem("fl.palette", String(palette));
        ov.remove();
        resolve({ starter, palette });
      };
    });
  }

  dispose() {
    this.root.remove();
  }
}

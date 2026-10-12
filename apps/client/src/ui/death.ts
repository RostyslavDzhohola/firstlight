// Death screen (verdict: Entry B, plus Entry A's "killed by a party member" joke card). The world
// drains to grey behind a dark scrim; the stats sit on their own scrim panel. Killer cards: cold
// Meridian Oversight, warm player, warm party member (joke), creature, the world (falls), yourself.

import "./death.css";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { config } from "../config.ts";
import { button, el, icon, overlayClosed, overlayOpened, sprite, uiRoot } from "./dom.ts";
import { aliveParts, classifyKiller, type KillerInfo } from "./hudFormat.ts";
import { itemSprite, portraitSprite } from "./sprites.ts";

export interface DeathInfo {
  killerName: string;
  aliveMs: number;
  level: number;
  /** Session id of the killer (players and NPCs); null for the world. */
  killer?: string | null;
  /** Our session id (the server's `victim`). */
  victim?: string;
  pileId?: string;
  /** Body we died on, e.g. "arcadia". */
  body?: string;
  /** For player killers, when the room state knows them. */
  killerStarter?: number;
  killerLevel?: number;
  /** Social lane: is this session in our party? */
  isParty?: (id: string) => boolean;
}

interface DeathContext {
  name: string;
  starter: number;
  lastAlive: { hotbar: (InvItem | null)[]; backpack: (InvItem | null)[]; coins: number; level: number } | null;
  pick: () => Promise<{ starter: number; palette: number }>;
}

const BARKS = ["Asset non-compliant. Escalating.", "Your access has been revoked.", "Thank you for your cooperation.", "Incident closed. Next."];

const bodyName = (b?: string) => (b ? b[0]!.toUpperCase() + b.slice(1) : "");

function killerCard(parent: HTMLElement, k: KillerInfo, info: DeathInfo): void {
  if (k.kind === "oversight") {
    const card = el("div", "fl-killer fl-cold", parent);
    const glyph = el("div", "fl-killer__glyph", card);
    el("span", "fl-hex", glyph);
    el("span", "fl-hex", glyph);
    el("span", "fl-killer__slit", glyph);
    const t = el("div", "", card);
    el("div", "fl-killer__k", t, "KILLED BY");
    el("div", "fl-killer__n", t, k.name);
    el("div", "fl-killer__m", t, "Meridian Oversight");
    el("q", "fl-killer__q", t, BARKS[Math.floor(info.aliveMs / 1000) % BARKS.length]!);
    return;
  }
  const warm = k.kind === "player" || k.kind === "party" || k.kind === "self";
  const card = el("div", `fl-killer fl-killer--warm${k.kind === "party" ? " is-party" : ""}`, parent);
  const face = el("div", "fl-face fl-face--lg", card);
  if (warm) sprite(portraitSprite(k.kind === "self" ? undefined : info.killerStarter), "", face);
  else sprite(k.kind === "world" ? "alert" : "crown", "", face);
  const t = el("div", "", card);
  const kicker = { player: "Killed by a player", party: "Killed by your party member", self: "Killed by", creature: "Killed by", world: "Killed by", oversight: "" }[k.kind];
  el("div", "fl-killer__k", t, kicker);
  el("div", "fl-killer__n", t, k.kind === "self" ? "Yourself" : k.name);
  const m = el("div", "fl-killer__m", t);
  if (k.kind === "player" || k.kind === "party") {
    const bits = [info.killerStarter !== undefined ? STARTERS[info.killerStarter]?.name : null, info.killerLevel ? `Lv ${info.killerLevel}` : null].filter(Boolean);
    m.textContent = bits.join(" · ");
    if (k.kind === "party") el("p", "fl-killer__joke", t, "With friends like these… Friendly fire is on everywhere outside safe zones.");
  } else if (k.kind === "self") m.textContent = "Own goal. Explosives hurt their owner too.";
  else if (k.kind === "world") m.textContent = /fall/i.test(k.name) ? "Falls past 8 m hurt; past 20 m they kill. Deep water breaks a fall." : "";
  else m.textContent = bodyName(info.body);
}

function lostItems(ctx: DeathContext): InvItem[] {
  const a = ctx.lastAlive;
  return a ? [...a.hotbar, ...a.backpack].filter((x): x is InvItem => !!x) : [];
}

let open: Promise<{ starter: number; palette: number }> | null = null;

export function showDeath(info: DeathInfo, ctx: DeathContext): Promise<{ starter: number; palette: number }> {
  if (open) return open;
  open = new Promise((resolve) => {
    document.exitPointerLock?.();
    overlayOpened("death");
    const ov = el("div", "fl-overlay fl-ui fl-death", uiRoot());
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "You died");
    el("div", "fl-death__drain", ov);
    el("div", "fl-death__shade", ov);
    el("div", "fl-grain", ov);

    const screen = el("main", "fl-death__screen", ov);
    const left = el("section", "fl-death__left", screen);
    const where = bodyName(info.body);
    el("div", "fl-eyebrow", left, `Life ended${where ? ` · ${where}` : ""} · level ${info.level}`);
    el("h1", "", left, "You died.");
    const lede = el("p", "fl-death__lede", left, "Everything you carried scattered into light where you fell. ");
    el("em", "", lede, "It's still there.");

    killerCard(left, classifyKiller(info, info.victim ?? null, { isParty: info.isParty }), info);

    const stats = el("div", "fl-death__stats", left);
    const alive = el("div", "", stats);
    el("span", "fl-label", alive, "Time alive");
    const ab = el("b", "num", alive);
    for (const p of aliveParts(info.aliveMs)) {
      ab.append(p.value);
      el("small", "", ab, p.unit);
      ab.append(" ");
    }
    const lv = el("div", "", stats);
    el("span", "fl-label", lv, "Level reached");
    el("b", "num", lv, String(info.level));

    const actions = el("div", "fl-death__actions", left);
    const riseWrap = el("div", "", actions);
    const rise = button("Rise again", "fl-btn fl-btn--primary fl-btn--lg fl-death__rise", riseWrap);
    el("span", "fl-death__sub", riseWrap, "Pick any starter · reborn in Portus at level 1");
    if (config.publicRepo) {
      const gh = el("div", "fl-death__gh", actions, "Like it? It's open source.");
      const star = el("a", "fl-btn fl-btn--sm", gh);
      icon("star", "", star);
      star.append("Star");
      star.href = config.repoUrl;
      const fork = el("a", "fl-btn fl-btn--sm", gh);
      icon("fork", "", fork);
      fork.append("Fork");
      fork.href = `${config.repoUrl}/fork`;
      for (const a of [star, fork]) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    }

    el("div", "", screen);

    const right = el("aside", "fl-death__right", screen);
    const lost = el("section", "fl-death__lost fl-panel", right);
    const items = lostItems(ctx);
    const h = el("h2", "fl-label", lost, "Left in your pile ");
    el("span", "fl-muted num", h, `${items.length} item${items.length === 1 ? "" : "s"}`);
    if (items.length) {
      const grid = el("div", "fl-death__items", lost);
      for (const it of items.slice(0, 20)) {
        const tile = el("span", "fl-death__it", grid);
        sprite(itemSprite(it.id), "", tile);
        if (it.qty > 1) el("span", "fl-death__q num", tile, String(it.qty));
      }
    }
    const rows = el("div", "fl-rows", lost);
    const coins = el("div", "", rows);
    el("span", "", coins, "Coins");
    el("b", "num fl-coin", coins, (ctx.lastAlive?.coins ?? 0).toLocaleString("en-US"));
    const lvl = el("div", "", rows);
    el("span", "", lvl, "Level");
    el("b", "num", lvl, `${info.level} → 1`);
    el("p", "fl-death__where", lost, items.length || ctx.lastAlive?.coins
      ? "Your pile stays where you fell and never expires. Anyone can loot it, including the next you, if you can get back."
      : "You weren't carrying anything this time.");

    const kept = el("section", "fl-death__kept fl-panel fl-panel--quiet", right);
    el("h2", "fl-label", kept, "You keep");
    const ul = el("ul", "", kept);
    for (const k of [ctx.name ? `Name · ${ctx.name}` : "Your name", "Medals and titles", "Hall of Firsts plaques", "Discovered pads"]) {
      const li = el("li", "", ul);
      icon("check", "", li);
      li.append(k);
    }

    rise.onclick = async () => {
      ov.remove();
      overlayClosed("death");
      open = null;
      resolve(await ctx.pick());
    };
    rise.focus();
  });
  return open;
}

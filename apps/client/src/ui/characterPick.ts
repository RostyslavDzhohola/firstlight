// Character pick (verdict: Entry B): starter list with rendered portraits, a spotlit hero figure (a
// render of the real 3D model in the chosen palette), weapon stats, palette swatches and, on first
// play, the display-name field. Renders come from tools/blender/chars3d (render.py, the game look).
// Used for the first play and for rebirth (no life counter: the server doesn't send one).

import "./character.css";
import { STARTERS, PALETTE_NAMES, WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { NAME_PATTERN, setDisplayName } from "../net/auth.ts";
import { nameProblem, validSuggestion } from "./account.ts";
import { button, el, icon, isolateKeys, overlayClosed, overlayOpened, sprite, uiRoot } from "./dom.ts";
import { config } from "../config.ts";
import { weaponChips } from "./hudFormat.ts";
import { installSprites, itemSprite, portraitSprite } from "./sprites.ts";

export interface CharacterPickOptions {
  /** Old call form: a custom heading. */
  title?: string;
  /** Rebirth after death: "Rise again", no name field, what carries over. */
  rebirth?: boolean;
  /** First play: also pick the display name (saved with setDisplayName when Play is pressed). */
  askName?: { suggested?: string };
}

const STARTER_COPY = [
  { role: "Young wizard", line: "Writes glowing glyphs in the air.", weapon: "Quill wand · writes light", pal: "Robe, scarf and the glyphs he writes." },
  { role: "Hooded desert monk-knight", line: "Blocks bolts with a blade of sunlight.", weapon: "Energy blade · stowed on the back", pal: "Robe, wraps and the hilt inlays. The Sunbrand blade always burns the same colour." },
  { role: "River ninja from the old stories", line: "Sweeps whole crowds with a bo staff.", weapon: "Bo staff · knocks back", pal: "Shell rim, hat band and wraps. Kappa's skin stays river-green." },
  { role: "Ivory-armoured trooper", line: "Steady blaster, one round lens.", weapon: "Compact carbine · battery cell", pal: "Armour plates, undersuit and the lens." },
  { role: "Fire ninja", line: "Throws kunai; a hand seal looses a fireball.", weapon: "Thrown kunai · hold RMB: Ember Seal", pal: "Hood, jacket and scarf, and the ember emblem on the back." },
] as const;

/** content.md §8.2: each starter's default palette (Midnight, Sand, Moss, Ivory, Ember). */
const DEFAULT_PALETTE = [2, 1, 3, 0, 4];

/** The hero render of a starter in a palette (480×720 WebP). */
const heroUrl = (starter: number, palette: number) => `${config.assetBase}/characters/hero_${STARTERS[starter]!.id}_${palette}.webp`;
const PAL_KEYS = ["ivory", "sand", "midnight", "moss", "ember", "dusk"];

let open: Promise<{ starter: number; palette: number }> | null = null;
const preloaded = new Set<string>();

export function showCharacterPick(opts: CharacterPickOptions = {}): Promise<{ starter: number; palette: number }> {
  if (open) return open;
  installSprites();
  open = new Promise((resolve) => {
    const rebirth = !!opts.rebirth;
    const storedStarter = localStorage.getItem("fl.starter");
    let starter = Math.max(0, Math.min(STARTERS.length - 1, Number(storedStarter ?? 0) || 0));
    let palette = Math.max(0, Math.min(5, Number(localStorage.getItem("fl.palette") ?? DEFAULT_PALETTE[starter]) || 0));
    let paletteTouched = storedStarter !== null;

    document.exitPointerLock?.();
    overlayOpened("charpick");
    const ov = el("div", "fl-overlay fl-ui fl-charpick", uiRoot());
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", rebirth ? "Rise again" : "Choose your starter");
    isolateKeys(ov);
    el("div", "fl-charpick__stage", ov);
    el("div", "fl-grain", ov);

    const screen = el("div", "fl-charpick__screen", ov);
    const top = el("header", "fl-charpick__top", screen);
    const mark = el("div", "fl-wordmark fl-wordmark--sm", top, "First");
    el("b", "", mark, "light");
    const h1 = el("h1", "", top, opts.title ?? (rebirth ? "Rise again" : "Choose your starter"));
    el("small", "", h1, rebirth ? "Your next life begins in Portus at level 1 with your starter weapon." : "Any starter, any palette. You can choose again every time you die.");
    const right = el("div", "fl-charpick__chip", top);
    el("span", "fl-chip fl-chip--dawn", right, rebirth ? "New life" : "First life");

    const cols = el("main", "fl-charpick__cols", screen);

    // ---- starters
    const list = el("section", "fl-charpick__starters", cols);
    list.setAttribute("aria-label", "Starters");
    el("div", "fl-label", list, "Starter");
    const cards = STARTERS.map((s, i) => {
      const b = button("", "fl-starter", list);
      const portrait = el("span", "fl-starter__portrait", b);
      sprite(portraitSprite(i), "", portrait);
      const txt = el("span", "", b);
      el("span", "fl-starter__name", txt, s.name);
      el("span", "fl-starter__line", txt, STARTER_COPY[i]!.line);
      const w = el("span", "fl-starter__wpn", txt);
      sprite(itemSprite(s.weapon), "", w);
      w.append(`${WEAPON_BY_ID.get(s.weapon)?.name ?? s.weapon} I`);
      b.onclick = () => {
        starter = i;
        if (!paletteTouched) palette = DEFAULT_PALETTE[i]!;
        render();
      };
      return b;
    });

    // ---- hero figure
    const hero = el("section", "fl-charpick__hero", cols);
    const wrap = el("div", "fl-charpick__figure-wrap", hero);
    el("div", "fl-charpick__beam", wrap);
    el("div", "fl-charpick__spot", wrap);
    const ped = el("div", "fl-charpick__pedestal", wrap);
    for (let i = 0; i < 3; i++) el("i", "", ped);
    const fig = el("div", "fl-charpick__figure", wrap);
    const img = el("img", "", fig);
    img.decoding = "async";
    img.draggable = false;
    const ident = el("div", "fl-charpick__identity", hero);
    const heroName = el("h2", "", ident);
    const heroRole = el("p", "fl-charpick__role", ident);
    const wcard = el("div", "fl-charpick__weapon fl-panel fl-panel--quiet", ident);
    const wSprite = sprite("fists", "", wcard);
    const wText = el("div", "", wcard);
    const wName = el("b", "", wText);
    const wLine = el("span", "", wText);
    const chips = el("div", "fl-charpick__stats", wcard);

    // ---- palette, name, play
    const cfg = el("aside", "fl-charpick__config fl-panel", cols);
    const palBlock = el("div", "", cfg);
    const palHead = el("h4", "fl-label fl-charpick__h", palBlock, "Palette ");
    const palName = el("em", "", palHead);
    const swatches = el("div", "fl-charpick__swatches", palBlock);
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Palette");
    const sw = PALETTE_NAMES.map((n, i) => {
      const b = button("", `fl-swatchbtn fl-pal--${PAL_KEYS[i]}`, swatches);
      el("i", "fl-swatch", b);
      el("span", "", b, n);
      b.setAttribute("role", "radio");
      b.onclick = () => {
        palette = i;
        paletteTouched = true;
        render();
      };
      return b;
    });
    const palHint = el("p", "fl-charpick__hint", palBlock);

    let nameInput: HTMLInputElement | null = null;
    let nameStatus: HTMLElement | null = null;
    let nameCount: HTMLElement | null = null;
    if (opts.askName && !rebirth) {
      const field = el("div", "fl-charpick__field", cfg);
      const lab = el("label", "fl-label", field, "Display name");
      lab.htmlFor = "fl-name";
      const iw = el("div", "fl-charpick__input", field);
      nameInput = el("input", "fl-input", iw);
      nameInput.id = "fl-name";
      nameInput.maxLength = 16;
      nameInput.setAttribute("autocomplete", "nickname");
      nameInput.spellcheck = false;
      // Generated guest names ("Wanderer-7904") fail the rules: only pre-fill a valid suggestion.
      nameInput.value = validSuggestion(opts.askName.suggested);
      nameInput.placeholder = "Your name";
      icon("check", "fl-charpick__ok", iw);
      const row = el("div", "fl-charpick__row", field);
      nameStatus = el("span", "fl-status", row);
      nameCount = el("span", "fl-charpick__count num", row);
      el("div", "fl-charpick__rules", field, "3–16 letters, numbers or _ · shown above your head");
      nameInput.addEventListener("input", () => checkName());
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void go();
      });
    }
    if (rebirth) {
      const kept = el("div", "fl-charpick__kept", cfg);
      el("div", "fl-label", kept, "You keep");
      const ul = el("ul", "", kept);
      for (const k of ["Your name", "Medals and titles", "Hall of Firsts plaques", "Discovered pads"]) {
        const li = el("li", "", ul);
        icon("check", "", li);
        li.append(k);
      }
    }
    const goWrap = el("div", "fl-charpick__go", cfg);
    const play = button("", "fl-btn fl-btn--primary fl-btn--lg fl-btn--block", goWrap);
    el("small", "", goWrap, rebirth ? "Your old pile is still where you fell." : "You start in Portus town, a safe zone. Creeps roam outside its walls.");

    function checkName(): boolean {
      if (!nameInput || !nameStatus || !nameCount) return true;
      const v = nameInput.value.trim();
      const ok = NAME_PATTERN.test(v);
      nameCount.textContent = `${v.length} / 16`;
      nameInput.classList.toggle("is-ok", ok);
      nameInput.classList.toggle("is-error", v.length > 0 && !ok);
      nameStatus.className = `fl-status${ok ? " is-ok" : v.length ? " is-error" : ""}`;
      nameStatus.textContent = ok ? "Looks good" : nameProblem(v);
      play.disabled = !ok;
      play.title = ok ? "" : nameProblem(v);
      return ok;
    }

    function render() {
      cards.forEach((c, i) => {
        c.classList.toggle("is-on", i === starter);
        c.setAttribute("aria-pressed", String(i === starter));
      });
      sw.forEach((b, i) => {
        b.classList.toggle("is-on", i === palette);
        b.setAttribute("aria-checked", String(i === palette));
      });
      palName.textContent = PALETTE_NAMES[palette]!;
      palHint.textContent = STARTER_COPY[starter]!.pal;
      fig.className = `fl-charpick__figure fl-pal--${PAL_KEYS[palette]}`;
      img.src = heroUrl(starter, palette);
      img.alt = `${STARTERS[starter]!.name} in the ${PALETTE_NAMES[palette]} palette`;
      // The other palettes of this starter load in the background so swatches swap instantly.
      for (let p = 0; p < PALETTE_NAMES.length; p++) {
        const url = heroUrl(starter, p);
        if (preloaded.has(url)) continue;
        preloaded.add(url);
        new Image().src = url;
      }
      // Re-run the projector flicker on change.
      fig.getAnimations().forEach((a) => {
        a.cancel();
        a.play();
      });
      heroName.textContent = STARTERS[starter]!.name;
      heroRole.textContent = STARTER_COPY[starter]!.role;
      const def = WEAPON_BY_ID.get(STARTERS[starter]!.weapon)!;
      wSprite.className = `px px-${itemSprite(def.id)}`;
      wName.textContent = `${def.name} I`;
      wLine.textContent = STARTER_COPY[starter]!.weapon;
      chips.replaceChildren(...weaponChips(def).map((c) => el("span", "fl-chip", undefined, c)));
      play.textContent = rebirth ? "Rise in Portus" : `Play as ${STARTERS[starter]!.name}`;
    }

    let busy = false;
    async function go() {
      if (busy || !checkName()) return;
      if (nameInput && nameStatus) {
        busy = true;
        play.disabled = true;
        nameStatus.className = "fl-status";
        nameStatus.textContent = "Checking…";
        const r = await setDisplayName(nameInput.value.trim()).catch(() => ({ ok: false as const, message: "Couldn't reach the server. Try again." }));
        busy = false;
        play.disabled = false;
        if (!r.ok) {
          nameStatus.className = "fl-status is-error";
          nameStatus.textContent = r.message;
          nameInput.classList.add("is-error");
          nameInput.focus();
          return;
        }
      }
      localStorage.setItem("fl.starter", String(starter));
      localStorage.setItem("fl.palette", String(palette));
      ov.remove();
      overlayClosed("charpick");
      open = null;
      resolve({ starter, palette });
    }
    play.onclick = () => void go();
    render();
    checkName();
    (nameInput ?? play).focus();
  });
  return open;
}

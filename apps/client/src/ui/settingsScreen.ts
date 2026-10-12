// Settings (verdict: Entry B): every control visible at once. Graphics go through the real render API
// (game.ctx + game.applyGraphics, so the shader warm-up re-runs), volumes through GameAudio, controls
// and comfort through uiSettings; voice through the voice lane's client and its Voice & radio panel.

import type { Game } from "../game/Game.ts";
import { FEATURES, killSwitches, resolveSettings, TIERS, type Feature, type Tier } from "../render/quality.ts";
import { button, el, icon, isolateKeys } from "./dom.ts";
import { formatDamage } from "./hudFormat.ts";
import { FOV_RANGE, SENSITIVITY_RANGE, uiSettings, type UiSettings, type UiSettingsPatch } from "./uiSettings.ts";
import { openVoicePanel, voice } from "../voice/index.ts";

/** Player-facing toggles (F3 keeps the rest: sky planets, vignette, post, chars, motes, detail). */
const TOGGLES: [Feature, string][] = [
  ["bloom", "Bloom"],
  ["fog", "Fog & haze"],
  ["sky", "Sky scattering"],
  ["shadows", "Shadows"],
  ["cascades", "Long shadows"],
  ["grass", "Grass"],
  ["trees", "Trees & rocks"],
  ["water", "Water"],
  ["ao", "Ambient occlusion"],
  ["fxaa", "Anti-aliasing"],
  ["traa", "Temporal AA"],
  ["grain", "Film grain"],
  ["particles", "Particles"],
  ["destruct", "Debris"],
];

const TIER_LABEL: Record<Tier | "auto", string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", ultra: "Ultra" };
const VOLUMES: [keyof Game["audio"]["volumes"], string][] = [["master", "Master"], ["music", "Music"], ["sfx", "Effects"], ["voice", "Voice"]];

function range(parent: HTMLElement, id: string, min: number, max: number, step: number, value: number): HTMLInputElement {
  const r = el("input", "fl-range", parent);
  r.type = "range";
  r.id = id;
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  r.value = String(value);
  const fill = () => r.style.setProperty("--val", `${(((Number(r.value) - min) / (max - min)) * 100).toFixed(1)}%`);
  fill();
  r.addEventListener("input", fill);
  return r;
}

function toggle(parent: HTMLElement, cls: string, label: string, sub: string | null, checked: boolean, disabled = false): HTMLInputElement {
  const l = el("label", `${cls}${disabled ? " is-off" : ""}`, parent);
  if (cls === "fl-line") {
    const d = el("span", "fl-line__desc", l, label);
    if (sub) el("small", "", d, sub);
  } else {
    el("span", "", l, label);
    // Why a feature is unavailable goes in the tooltip, so labels never truncate.
    if (sub) l.title = `${label}: ${sub}`;
  }
  const i = el("input", "fl-switch", l);
  i.type = "checkbox";
  i.checked = checked;
  i.disabled = disabled;
  return i;
}

/** Build the settings screen into `host`. Returns a cleanup function. */
export function openSettings(game: Game, host: HTMLElement, back: () => void): () => void {
  const ctx = game.ctx;
  const root = el("div", "fl-settings", host);
  isolateKeys(root);
  const cleanups: (() => void)[] = [];

  const top = el("header", "fl-settings__top", root);
  const backBtn = button("", "fl-btn fl-btn--ghost fl-btn--sm", top, back);
  icon("chev-l", "", backBtn);
  backBtn.append("Menu");
  el("h1", "", top, "Settings");
  el("span", "fl-grow", top);
  el("span", "fl-settings__note", top, "Changes apply live · stored on this browser");
  const reset = button("", "fl-btn fl-btn--sm", top, () => {
    flashSaved();
    const stored = ctx.stored();
    void game.applyGraphics(() => {
      ctx.setRenderScale(null);
      for (const f of FEATURES) if (stored.features[f] !== undefined) ctx.setFeature(f, null);
      ctx.setAutoTier();
    });
  });
  icon("refresh", "", reset);
  reset.append("Reset graphics to detected");

  const cols = el("div", "fl-settings__cols", root);
  const bottom = el("footer", "fl-settings__bottom", root);
  const saved = el("span", "fl-saved", bottom);
  icon("check", "", saved);
  saved.append("Saved");
  el("span", "", bottom, "Esc or Menu to go back");
  el("span", "fl-grow", bottom);
  el("span", "", bottom, "Quality changes re-warm the shaders for a moment. No reload.");
  let savedTimer = 0;
  const flashSaved = () => {
    saved.classList.add("is-on");
    clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => saved.classList.remove("is-on"), 1400);
  };
  const setUi = (p: UiSettingsPatch) => {
    uiSettings.set(p);
    flashSaved();
  };

  // ------------------------------------------------------------------------------------------ graphics
  const gfx = el("section", "fl-settings__col fl-panel", cols);
  const renderGraphics = () => {
    gfx.replaceChildren();
    const s = ctx.settings;
    const stored = ctx.stored();
    const h = el("h2", "", gfx);
    icon("monitor", "", h);
    h.append("Graphics");
    el("small", "", h, `${ctx.webgpu ? "WebGPU" : "WebGL2"} · ${TIER_LABEL[s.tier]}${s.auto ? " (auto)" : ""}`);

    const tier = el("div", "fl-setting", gfx);
    el("div", "fl-setting__row", tier, "Quality");
    const seg = el("div", "fl-seg fl-seg--block", tier);
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Quality tier");
    const current: Tier | "auto" = stored.tier ?? "auto";
    for (const t of ["auto", ...TIERS] as const) {
      const b = button(TIER_LABEL[t], t === current ? "is-on" : "", seg);
      b.setAttribute("aria-pressed", String(t === current));
      b.onclick = () => {
        if (t === current) return;
        flashSaved();
        void game.applyGraphics(() => (t === "auto" ? ctx.setAutoTier() : ctx.setTier(t)));
      };
    }
    const det = el("div", "fl-setting__detected", tier);
    icon("check", "", det);
    const dt = el("span", "", det, "Detected ");
    el("b", "", dt, stored.autoTier ?? "medium");
    dt.append(" for this computer. Auto follows it and steps down if frames get slow.");

    const rs = el("div", "fl-setting", gfx);
    const rsRow = el("div", "fl-setting__row", rs);
    const rsLab = el("label", "", rsRow, "Render scale");
    rsLab.htmlFor = "fl-rs";
    const scale = stored.renderScale ?? s.renderScale;
    const rsOut = el("output", "num", rsRow, `${Math.round(scale * 100)}%`);
    const rsIn = range(rs, "fl-rs", 50, 100, 1, Math.round(Math.min(1, scale) * 100));
    rsIn.addEventListener("input", () => (rsOut.textContent = `${rsIn.value}%`));
    rsIn.addEventListener("change", () => {
      ctx.setRenderScale(Number(rsIn.value) / 100);
      flashSaved();
    });
    el("div", "fl-setting__hint", rs, `Tier default ${Math.round(s.renderScale * 100)}%. Drops automatically to 79 / 62 / 50% if frames get slow.`);

    const fov = el("div", "fl-setting", gfx);
    const fovRow = el("div", "fl-setting__row", fov);
    const fovLab = el("label", "", fovRow, "Field of view");
    fovLab.htmlFor = "fl-fov";
    const fovOut = el("output", "num", fovRow, `${uiSettings.get().fov}°`);
    const fovIn = range(fov, "fl-fov", FOV_RANGE[0], FOV_RANGE[1], 1, uiSettings.get().fov);
    fovIn.addEventListener("input", () => {
      fovOut.textContent = `${fovIn.value}°`;
      setUi({ fov: Number(fovIn.value) });
    });

    el("hr", "", gfx);
    el("div", "fl-settings__sub", gfx, "Per feature");
    const grid = el("div", "fl-toggles", gfx);
    const kills = killSwitches();
    for (const [f, label] of TOGGLES) {
      // Available on this tier/backend? Resolve once with the feature forced on.
      const avail = resolveSettings(s.tier, s.auto, s.webgpu, { ...stored, features: { ...stored.features, [f]: true } }, kills).on[f];
      const note = kills.has(f) ? "turned off by a URL flag" : avail ? null : (f === "ao" || f === "traa") && !ctx.webgpu ? "needs WebGPU and High or Ultra" : "needs a higher quality tier";
      const sw = toggle(grid, "fl-tg", label, note, s.on[f], !avail);
      sw.onchange = () => {
        flashSaved();
        void game.applyGraphics(() => ctx.setFeature(f, sw.checked));
      };
    }
  };
  renderGraphics();
  cleanups.push(ctx.onChange(() => renderGraphics()));

  // ------------------------------------------------------------------------------------------ controls + audio + comfort
  const mid = el("section", "fl-settings__col fl-panel", cols);
  const ui = uiSettings.get();
  const ch = el("h2", "", mid);
  icon("mouse", "", ch);
  ch.append("Controls");
  const sens = el("div", "fl-setting", mid);
  const sensRow = el("div", "fl-setting__row", sens);
  const sensLab = el("label", "", sensRow, "Mouse sensitivity");
  sensLab.htmlFor = "fl-sens";
  const sensOut = el("output", "num", sensRow, ui.sensitivity.toFixed(2));
  const sensIn = range(sens, "fl-sens", SENSITIVITY_RANGE[0], SENSITIVITY_RANGE[1], 0.05, ui.sensitivity);
  sensIn.addEventListener("input", () => {
    sensOut.textContent = Number(sensIn.value).toFixed(2);
    setUi({ sensitivity: Number(sensIn.value) });
  });
  const inv = toggle(mid, "fl-line", "Invert Y", "Pull the mouse back to look up", ui.invertY);
  inv.onchange = () => setUi({ invertY: inv.checked });
  el("div", "fl-setting__hint", mid, "Full key list: Menu → How to play.");

  el("hr", "", mid);
  const ah = el("h2", "", mid);
  icon("speaker", "", ah);
  ah.append("Audio");
  const vols = el("div", "fl-vols", mid);
  for (const [k, label] of VOLUMES) {
    const row = el("label", "fl-vol", vols, label);
    const v = Math.round((game.audio?.volumes[k] ?? 0.8) * 100);
    const r = range(row, `fl-vol-${k}`, 0, 100, 1, v);
    const out = el("output", "num", row, String(v));
    r.addEventListener("input", () => {
      out.textContent = r.value;
      if (!game.audio) return;
      game.audio.volumes[k] = Number(r.value) / 100;
      game.audio.applyVolumes();
      flashSaved();
    });
  }

  el("hr", "", mid);
  const comfort = el("h2", "", mid);
  icon("eye", "", comfort);
  comfort.append("Comfort");
  const shake = toggle(mid, "fl-line", "Screen shake", "Light camera shake on big hits", ui.shake);
  shake.onchange = () => setUi({ shake: shake.checked });
  const dmg = toggle(mid, "fl-line", "Damage numbers", "Float above whatever you hit", ui.damageNumbers);
  dmg.onchange = () => setUi({ damageNumbers: dmg.checked });

  // ------------------------------------------------------------------------------------------ voice + colour
  // The voice lane owns the opt-in (16+), devices and radio (its "Voice & radio" panel); this column
  // shows the state, the strangers switch and opens that panel.
  const right = el("section", "fl-settings__col fl-panel", cols);
  const vc = voice();
  const vh = el("h2", "", right);
  icon("mic", "", vh);
  vh.append("Voice");
  el("small", "", vh, vc?.optedIn ? (vc.enabled ? "On" : "Opted in, off") : "Off until you opt in");
  const card = el("div", "fl-voicecard", right);
  const age = el("div", "fl-age", card);
  icon(vc?.optedIn ? "check" : "lock", "", age);
  const ageT = el("span", "", age, vc?.optedIn ? "You confirmed you're 16 or older" : "Voice needs you to be 16 or older");
  el("small", "", ageT, vc?.optedIn ? "Push to talk with V, the radio with B." : "Opt in once from the Voice & radio panel.");
  if (vc) {
    const ms = toggle(card, "fl-line", "Mute strangers", "Only hear your party", vc.muteStrangers);
    ms.onchange = () => {
      vc.setMuteStrangers(ms.checked);
      flashSaved();
    };
  }
  const open = button("", "fl-btn fl-btn--block", card, () => openVoicePanel());
  icon("radio", "", open);
  open.append("Voice & radio");
  open.disabled = !vc;
  if (!vc) el("div", "fl-setting__hint", card, "Voice starts when you join a world (needs WebRTC).");

  const priv = el("div", "fl-private", right);
  icon("shield", "", priv);
  const pt = el("span", "", priv);
  el("b", "", pt, "Never recorded. ");
  pt.append("Voice goes player to player through a relay and is not stored anywhere. Shift + Esc mutes everyone instantly.");

  el("hr", "", right);
  const cb = toggle(right, "fl-line", "Colour-blind damage colours", "Yellow weak points, cyan shields. Size and “!” always mark weak points.", ui.cbDamage);
  cb.onchange = () => setUi({ cbDamage: cb.checked });
  const prev = el("div", "fl-dmgprev", right);
  prev.setAttribute("aria-label", "Damage number preview");
  for (const [n, k] of [[31, "normal"], [47, "weak"], [6, "armour"], [12, "shield"]] as const) {
    const f = formatDamage(n, k);
    el("span", f.cls, prev, f.text);
  }
  el("small", "", prev, "normal · weak · armour · shield");

  const sync = (s: UiSettings) => prev.classList.toggle("is-classic", !s.cbDamage);
  sync(uiSettings.get());
  cleanups.push(uiSettings.onChange((s) => sync(s)));

  backBtn.focus();
  return () => {
    for (const c of cleanups) c();
    clearTimeout(savedTimer);
    root.remove();
  };
}

// Dev-only UI gallery: every screen and HUD state with mock data, no server and no renderer.
// Open /ui-gallery.html?screen=hud (dev server). Screens: see SCREENS below. Add &live to keep the
// animations running (frozen by default so screenshots are stable).

import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/icons.css";
import "../styles/base.css";
import "../styles/landing.css";
import "../styles/loading.css";
import "./gallery.css";
import indexHtml from "../../../index.html?raw";
import type { Game } from "../../game/Game.ts";
import { loadStored, resolveSettings, type Feature, type Tier } from "../../render/quality.ts";
import { Hud, type YouPlus } from "../hud.ts";
import { setLoading, setLoadingBadge } from "../loading.ts";
import { Menu } from "../menu.ts";
import { showSavePrompt, showSignIn, pickDisplayName } from "../account.ts";
import { installSprites } from "../sprites.ts";
import { el } from "../dom.ts";

const SCREENS = [
  "landing", "loading", "loading-compact", "charpick", "charpick-rebirth", "hud", "hud-oversight", "hud-states",
  "death", "death-player", "death-party", "death-world", "menu", "menu-logout", "settings", "save", "save-code", "save-saved", "save-busy", "signin", "name", "notice",
] as const;
type Screen = (typeof SCREENS)[number];

const q = new URLSearchParams(location.search);
const screen = ((window as unknown as { __GALLERY?: string }).__GALLERY ?? q.get("screen") ?? "hud") as Screen;
if (!q.has("live")) document.documentElement.classList.add("fl-gallery-freeze");
if (q.has("low")) document.documentElement.classList.add("fl-lowfx");
installSprites();

const gameEl = document.getElementById("game")!;

function you(over: Partial<YouPlus> = {}): YouPlus {
  return {
    xp: 640, xpToNext: 925, coins: 214, level: 7, selected: 0, dead: false, logoutEndsAt: null, protectedUntil: 0,
    hotbar: [{ id: "carbine", tier: 2, qty: 1, mag: 21 }, { id: "stormcoil", tier: 2, qty: 1 }, { id: "grenade", tier: 1, qty: 3 }, { id: "sunbrand", tier: 3, qty: 1 }],
    backpack: [{ id: "patchkit", tier: 1, qty: 2 }, { id: "tonic_large", tier: 1, qty: 5 }, { id: "radio", tier: 1, qty: 1 }, ...Array(13).fill(null)],
    missions: [], medals: [], pads: [],
    ...over,
  };
}

/** Enough of Game for the menu and settings screens. */
function fakeGame(hud: Hud | null, opts: { logout?: boolean } = {}): Game {
  let stored = loadStored();
  let tier: Tier = "medium";
  const settings = () => resolveSettings(stored.tier ?? tier, !stored.tier, false, stored, new Set());
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  const ctx = {
    webgpu: false,
    get settings() {
      return settings();
    },
    stored: () => ({ ...stored, autoTier: stored.autoTier ?? "medium" }),
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setTier: (t: Tier) => ((stored = { ...stored, tier: t }), changed()),
    setAutoTier: () => ((stored = { ...stored, tier: null }), (tier = "medium"), changed()),
    setFeature: (f: Feature, on: boolean | null) => {
      const features = { ...stored.features };
      if (on === null) delete features[f];
      else features[f] = on;
      stored = { ...stored, features };
      changed();
    },
    setRenderScale: (s: number | null) => ((stored = { ...stored, renderScale: s }), changed()),
  };
  const players = new Map([["me", { name: "Wren_07", starter: 3, level: 7, flags: 0 }]]);
  return {
    ctx,
    hud,
    bodyId: "arcadia",
    audio: { volumes: { master: 0.8, music: 0.35, sfx: 0.8, voice: 1 }, applyVolumes() {} },
    applyGraphics: async (f: () => void) => f(),
    input: { lock() {} },
    net: { room: { sessionId: "me", state: { players }, send() {} }, serverOffset: 0 },
    combat: { deadUntilRespawn: false },
    resume: async () => {},
    ...(opts.logout && hud ? {} : {}),
  } as unknown as Game;
}

function hudScene(variant: "monster" | "oversight"): Hud {
  gameEl.className = "fl-gallery-world";
  const hud = new Hud();
  hud.setIdentity("Wren_07", 3, 0);
  hud.setYou(you());
  hud.setHp(38, 160);
  hud.setSafe(true);
  hud.setSafe(false);
  hud.bossBar(
    variant === "monster"
      ? { name: "Tidewrath", level: 8, hp: 9520, max: 16200, phase: 2, phaseName: "Undertow", notches: [0.6, 0.25], note: "3 in the arena" }
      : { name: "The Receiver", level: 20, hp: 18630, max: 40500, phase: 2, phaseName: "Restructuring", notches: [0.6, 0.25], note: "3 in the yard", variant: "oversight" },
  );
  hud.setParty([
    { slot: 2, name: "Mossback", level: 7, starter: 2, hp: 75, maxHp: 100, speaking: true, distance: 14 },
    { slot: 3, name: "Ashfall", level: 6, starter: 1, hp: 41, maxHp: 100, title: "Wrecker", distance: 22 },
    { slot: 4, name: "Pip_Hexer", level: 5, starter: 0, hp: 93, maxHp: 100, radio: true, distance: 212 },
  ]);
  hud.setMissions(
    [
      { id: "a", title: "Pest Control", detail: "Kill 8 Hopbits in Clover Fields", progress: "8/8", state: "done" },
      { id: "b", title: "The Lost Bell", detail: "Find the Shepherd's Bell at Lacefall", progress: "380 m", state: "tracked" },
      { id: "c", title: "The Big Lake", detail: "Reach the Gull Point overlook", progress: "0/1" },
    ],
    "Lark · Arcadia",
  );
  hud.toast("+8", "coins");
  hud.toast("The Big Lake", "mission", { sub: "Mission complete · +180 XP · +60 coins" });
  hud.toast("Demolition Crew", "medal", { title: "Medal unlocked", sub: "Broke 200 props · title “Wrecker” unlocked" });
  const w = innerWidth, h = innerHeight;
  hud.damageNumber(w * 0.54, h * 0.46, 47, true);
  hud.damageNumber(w * 0.57, h * 0.5, 31, false);
  hud.damageNumber(w * 0.62, h * 0.455, 6, false, "armour");
  hud.damageNumber(w * 0.6, h * 0.53, 12, false, "shield");
  hud.bubble(w * 0.3, h * 0.62, "Truce?", { name: "glasswing" });
  hud.bubble(w * 0.78, h * 0.6, "Boss here", { name: "Ashfall", slot: 3 });
  hud.hit(true);
  hud.setLogout(Date.now() + 18_000, Date.now());
  hud.setPrompt("E — take everything from Vexa_77's pile");
  hud.subtitle("Tidewrath", "Every tide comes back. So do I.", 60_000);
  const v = el("div", "fl-holo", hud.voiceSlot);
  v.append("Hold ");
  el("span", "fl-key", v, "V");
  v.append(" to talk");
  return hud;
}

async function run() {
  const nav = el("nav", "fl-gallery-nav", document.body);
  if (q.has("nav")) for (const s of SCREENS) el("a", s === screen ? "is-on" : "", nav, s).setAttribute("href", `?screen=${s}&nav`);
  switch (screen) {
    case "landing": {
      const m = /<section id="landing"[\s\S]*?<\/section>/.exec(indexHtml);
      document.body.insertAdjacentHTML("beforeend", m ? m[0] : "");
      document.getElementById("online")!.hidden = false;
      document.getElementById("online-n")!.textContent = "1,284";
      break;
    }
    case "loading":
    case "loading-compact":
      gameEl.className = "fl-gallery-world";
      setLoadingBadge("WebGPU · medium (auto)");
      setLoading("Travelling to Arcadia…", 0.15);
      setLoading("Connecting…", 0.3);
      setLoading("Building the world…", 0.58);
      if (screen === "loading-compact") setLoading("Applying graphics settings…", 0.5);
      break;
    case "charpick":
    case "charpick-rebirth": {
      const hud = new Hud();
      hud.root.hidden = true;
      void hud.characterPick(screen === "charpick" ? { askName: { suggested: "Wren_07" } } : { rebirth: true });
      break;
    }
    case "hud":
      hudScene("monster");
      break;
    case "hud-oversight":
      hudScene("oversight");
      break;
    case "hud-states": {
      gameEl.className = "fl-gallery-world";
      const hud = new Hud();
      hud.setIdentity("Pip_Hexer", 0, 2);
      hud.setYou(you({ level: 3, selected: 1, hotbar: [{ id: "hexquill", tier: 1, qty: 1 }, null, { id: "patchkit", tier: 1, qty: 2 }, { id: "stillshot", tier: 2, qty: 1, mag: 1 }] }));
      hud.setHp(120, 120);
      hud.setSafe(true);
      hud.toast("Weapons are holstered in safe zones", "warn");
      hud.toast("Level 3!", "xp");
      break;
    }
    case "death":
    case "death-player":
    case "death-party":
    case "death-world": {
      gameEl.className = "fl-gallery-world";
      const hud = new Hud();
      hud.setIdentity("Wren_07", 3, 0);
      hud.setYou(you({ coins: 1284 }));
      hud.root.hidden = true;
      const killer = { death: { killer: "n1", killerName: "npc:compliance_officer" }, "death-player": { killer: "p2", killerName: "Vexa_77" }, "death-party": { killer: "p3", killerName: "Mara_Vex" }, "death-world": { killer: null, killerName: "the fall" } }[screen];
      void hud.death({ ...killer, victim: "me", aliveMs: 6_120_000, level: 16, body: "meridian", killerStarter: 3, killerLevel: 19, isParty: (id) => id === "p3" });
      break;
    }
    case "menu":
    case "menu-logout": {
      gameEl.className = "fl-gallery-world";
      const hud = hudScene("monster");
      if (screen === "menu-logout") hud.you = { ...hud.you!, logoutEndsAt: Date.now() + 18_000 };
      new Menu(fakeGame(hud)).showPause();
      break;
    }
    case "settings": {
      gameEl.className = "fl-gallery-world";
      const hud = hudScene("monster");
      new Menu(fakeGame(hud)).showSettings();
      break;
    }
    case "save":
    case "save-code":
    case "save-saved":
    case "save-busy":
      hudScene("monster");
      void showSavePrompt({ name: "Wren_07", level: 2, starter: 3, preview: screen === "save" ? undefined : (screen.slice(5) as "code" | "saved" | "busy") });
      break;
    case "signin":
      gameEl.className = "fl-gallery-dark";
      void showSignIn();
      break;
    case "name":
      gameEl.className = "fl-gallery-dark";
      void pickDisplayName({ suggested: "Wanderer_ab12", dismissible: true });
      break;
    case "notice": {
      gameEl.className = "fl-gallery-world";
      new Menu(fakeGame(null)).showNotice("Playing elsewhere", "This character is playing in another tab or window.", "Play here", () => {});
      break;
    }
  }
}

void run();

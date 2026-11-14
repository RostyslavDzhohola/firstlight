// Dev-only UI gallery: every screen and HUD state with mock data, no server and no renderer.
// Open /ui-gallery.html?screen=hud (dev server). Screens: see SCREENS below. Add &live to keep the
// animations running (frozen by default so screenshots are stable).

import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/icons.css";
import "../styles/base.css";
import "../styles/landing.css";
import "../styles/home.css";
import "../styles/loading.css";
import "./gallery.css";
import "../trial.css";
import "../../social/social.css";
import indexHtml from "../../../index.html?raw";
import type { Game } from "../../game/Game.ts";
import { loadStored, resolveSettings, type Feature, type Tier } from "../../render/quality.ts";
import { Hud, type YouPlus } from "../hud.ts";
import { setLoading, setLoadingBadge, WEBGPU_SLOW_LINE } from "../loading.ts";
import { Menu } from "../menu.ts";
import { openSaveProgress, showSignIn, pickDisplayName } from "../account.ts";
import { installSprites } from "../sprites.ts";
import { applyUiLook } from "../look.ts";
import { el } from "../dom.ts";
import { Compass } from "../../social/compass.ts";
import { PlayerList } from "../../social/playerList.ts";
import { InviteCards } from "../../social/invites.ts";
import { showRemoved } from "../../social/screens.ts";
import { addInvite, setParty } from "../../social/store.ts";
import { PhraseWheel } from "../phraseWheel.ts";
import { JournalPanel } from "../panels.ts";
import { ShopPanel } from "../shop.ts";
import { SHOP_SPOTS } from "@firstlight/shared/content/shops";
import { InventoryPanel } from "../inventory.ts";
import { OnboardingHud } from "../onboarding.ts";
import { OnboardingSteps } from "../../game/onboardingSteps.ts";
import { ANIM } from "@firstlight/shared/net/schema";
import { INVENTORY_HTML, ONBOARDING_HTML } from "./kitExamples.ts";
import { paintHomeMock } from "../../home/home.ts";
import { arrivalCard } from "../arrivalCard.ts";
import { feedText } from "../eventFeed.ts";
import { levelMoments, medalMoment, missionMoments, type Moment } from "../moments.ts";
import { SpellBar } from "../spellBar.ts";
import { SPELLS } from "@firstlight/shared/content/spells";
import type { BodyId } from "@firstlight/shared/planet/bodies";
import type { HomeData } from "@firstlight/shared/net/home";

const SCREENS = [
  "og", "moment-level", "moment-spell", "moment-mission", "moment-trial", "moment-gleam", "moment-vault", "moment-medal", "arrival", "arrival-portus", "arrival-hollowmere", "arrival-meridian", "hud-full", "hud-combat",
  "landing", "home-guest", "loading", "loading-compact", "loading-webgpu", "charpick", "charpick-rebirth", "hud", "hud-oversight", "hud-states",
  "death", "death-player", "death-party", "death-world", "menu", "menu-logout", "settings",
  "players", "compass", "wheel", "shop", "journal", "invite", "removed", "kit-inventory", "kit-onboarding", "inventory", "inventory-drag", "onboarding", "onboarding-attack", "onboarding-loot", "onboarding-portal", "onboarding-done", "save", "save-code", "save-saved", "save-busy", "save-unavailable", "save-locked", "signin", "signin-unavailable", "name", "notice",
] as const;
type Screen = (typeof SCREENS)[number];

const q = new URLSearchParams(location.search);
const screen = ((window as unknown as { __GALLERY?: string }).__GALLERY ?? q.get("screen") ?? "hud") as Screen;
if (!q.has("live")) document.documentElement.classList.add("fl-gallery-freeze");
if (q.has("low")) document.documentElement.classList.add("fl-lowfx");
applyUiLook(document.documentElement, location.search); // &blur=1: the old blurred look (D-ui-1)
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

const HOME_MOCK: HomeData = {
  online: {
    total: 37,
    bodies: {
      portus: { players: 9, names: ["Ashfall", "Juno_V", "Kestrel", "Maren", "Pip_Lark", "Tamsin"] },
      arcadia: { players: 17, names: ["Bramble", "Cinder_7", "Mossback", "Wren_07"] },
      hollowmere: { players: 8, names: ["Lumen_K", "Orbit_9"] },
      meridian: { players: 3, names: ["Vexa_77"] },
    },
  },
  board: {
    levels: [
      { name: "Vexa_77", level: 19, starter: 3, title: "Triple Crown" },
      { name: "Mossback", level: 17, starter: 1, title: "Regicide" },
      { name: "Wren_07", level: 14, starter: 3, title: "Tide Turner" },
      { name: "Lumen_K", level: 11, starter: 0, title: "Seasoned" },
      { name: "Ashfall", level: 9, starter: 2, title: null },
      { name: "Tamsin", level: 6, starter: 0, title: null },
    ],
    medals: [
      { name: "Vexa_77", medals: 14, title: "Triple Crown" },
      { name: "Mossback", medals: 11, title: "Regicide" },
      { name: "Wren_07", medals: 7, title: "Tide Turner" },
    ],
    hall: [
      { id: "boss:tidewrath", name: "Mossback", foundAt: Date.UTC(2026, 9, 12) },
      { id: "E2", name: "Wren_07", foundAt: Date.UTC(2026, 9, 13) },
    ],
  },
  visits: { online: 52, total: 12840 },
  at: 0,
};
const ME_MOCK = {
  name: "Wren_07", displayName: "Wren_07", guest: false, titleMedal: "tide_turner",
  character: { level: 14, xp: 14_000, coins: 812, starter: "unit7", palette: 2, body: "hollowmere" },
  medals: ["spark", "ten_down", "grand_tour", "tide_turner", "regicide", "new_high_score", "bellringer"],
  pads: Array.from({ length: 19 }, (_, i) => ({ body: i < 12 ? "arcadia" : "hollowmere", padId: String(i % 12) })),
  playMs: 4 * 3600_000 + 12 * 60_000,
};

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

const PLAYERS = new Map<string, Record<string, unknown>>([
  ["me", { name: "Wren_07", userId: "u1", level: 7, starter: 3, flags: 0, party: "p1", x: 0, y: 500, z: 0, title: "" }],
  ["s2", { name: "Mossback", userId: "u2", level: 7, starter: 2, flags: 8, party: "p1", x: 8, y: 500, z: 11, title: "Wrecker" }],
  ["s3", { name: "glasswing", userId: "u3", level: 4, starter: 0, flags: 0, party: "", x: 40, y: 500, z: 30, title: "" }],
  ["s4", { name: "Vexa_77", userId: "u4", level: 19, starter: 3, flags: 128 | 8, party: "p9", x: 120, y: 480, z: 60, title: "Farshot" }],
  ["s5", { name: "Pip_Hexer_with_a_long_name", userId: "u5", level: 5, starter: 0, flags: 0, party: "", x: 15, y: 500, z: -20, title: "" }],
]);

function party() {
  setParty({
    id: "p1", leader: "u1",
    members: [
      { userId: "u1", name: "Wren_07", level: 7, online: true, body: "arcadia", roomId: "r", sessionId: "me", x: 0, y: 500, z: 0 },
      { userId: "u2", name: "Mossback", level: 7, online: true, body: "arcadia", roomId: "r", sessionId: "s2", x: 8, y: 500, z: 11 },
      { userId: "u6", name: "Ashfall", level: 6, online: true, body: "meridian", roomId: null, sessionId: null, x: 0, y: 0, z: 0 },
    ],
  });
}

/** One of each banner (D-ui-2), from the same builders the game uses. */
const MOMENTS: Record<string, () => Moment> = {
  level: () => levelMoments(6, 7)[0]!,
  spell: () => levelMoments(2, 3)[1]!,
  mission: () => missionMoments("A3", 180, 60)[0]!,
  trial: () => missionMoments("T1", 300, 80)[0]!,
  gleam: () => missionMoments("T1", 300, 80, [{ id: "T2", done: true }])[1]!,
  vault: () => missionMoments("vault", 0, 600)[0]!,
  medal: () => medalMoment("demolition_crew")!,
};

/** A calm HUD (player card, hotbar, spell bar and aether, a minimap stand-in) for the moments screens. */
function quietHud(body: BodyId = "arcadia"): Hud {
  gameEl.className = "fl-gallery-world";
  const hud = new Hud();
  hud.root.dataset.body = body;
  hud.setIdentity("Wren_07", 3, 0);
  hud.setYou(you());
  hud.setHp(132, 160);
  hud.setZone({ zone: "danger", label: "Danger", place: "The wilds", title: "", sub: "" });
  const bar = new SpellBar(hud.spellSlot, hud.aetherSlot);
  bar.update({
    aether: 64, max: 100, ward: null,
    slots: SPELLS.map((s, i) => ({ id: s.id, name: s.name, keycap: s.keycap, level: s.level, locked: i === 3, cooldown: i === 1 ? 4.2 : 0, cooldownFrac: i === 1 ? 0.42 : 0, short: false, ready: i !== 1 && i !== 3, cost: s.cost })),
  });
  const mm = el("div", "fl-minimap", hud.minimapSlot);
  mm.style.width = mm.style.height = "150px";
  return hud;
}

function showMoment(hud: Hud, m: Moment) {
  hud.moments.push(m);
  hud.moments.tick(performance.now());
}

function fullHud(combat: boolean): Hud {
  const hud = quietHud();
  hud.setMissions(
    [
      { id: "b", title: "The Lost Bell", detail: "Find the Shepherd's Bell at Lacefall", progress: "380 m", state: "tracked" },
      { id: "c", title: "The Big Lake", detail: "Reach the Gull Point overlook", progress: "0/1" },
    ],
    "Lark · Arcadia",
  );
  const now = performance.now();
  hud.moments.feed("join", feedText.joined({ name: "Mossback" }), now);
  hud.moments.feed("hunt", feedText.wonGleam({ name: "Tin_Lantern", agent: true }, "The Swift Gleam"), now);
  hud.moments.feed("death", feedText.fell({ name: "Pip_Hexer" }, "Hopbit Bruiser"), now);
  hud.moments.feed("kill", feedText.felled("Hopbit", 12, 3), now);
  // The trial strip, as game/TrialClient.ts builds it.
  const top = hud.root.querySelector(".fl-hud__top")!;
  const trial = el("section", "fl-trial fl-holo fl-corners is-normal", top);
  const text = el("div", "fl-trial__text", trial);
  el("span", "fl-trial__title", text, "The Swift Gleam");
  el("span", "fl-trial__progress", text, "Ring 4 of 8");
  el("span", "fl-trial__clock", trial, "0:41");
  showMoment(hud, MOMENTS[q.get("m") ?? "level"]!());
  hud.toast("+8", "coins");
  hud.toast("Not enough aether for Wishfall", "warn");
  const v = el("div", "fl-holo", hud.voiceSlot);
  v.append("Hold ");
  el("span", "fl-key", v, "V");
  v.append(" to talk");
  if (combat) {
    hud.setHp(34, 160);
    const w = innerWidth, h = innerHeight;
    hud.damageNumber(w * 0.56, h * 0.4, 47, true);
    hud.damageNumber(w * 0.6, h * 0.44, 31, false);
    hud.damageNumber(w * 0.64, h * 0.4, 6, false, "armour");
    hud.damageNumber(w * 0.6, h * 0.5, 12, false, "shield");
    hud.hit(true);
    hud.moments.hitFrom(118, now);
    hud.moments.hitFrom(250, now);
    hud.moments.kill();
    hud.root.classList.add("fl-gallery-combat");
  }
  return hud;
}

async function run() {
  const nav = el("nav", "fl-gallery-nav", document.body);
  if (q.has("nav")) for (const s of SCREENS) el("a", s === screen ? "is-on" : "", nav, s).setAttribute("href", `?screen=${s}&nav`);
  switch (screen) {
    case "landing":
    case "home-guest": {
      const m = /<section id="landing"[\s\S]*<\/section>/.exec(indexHtml);
      document.body.insertAdjacentHTML("beforeend", m ? m[0] : "");
      const guest = screen === "home-guest";
      paintHomeMock(HOME_MOCK, guest ? { ...ME_MOCK, guest: true, displayName: null, name: "Wanderer-4410", titleMedal: null, character: { ...ME_MOCK.character!, level: 3, xp: 260 } } : ME_MOCK, guest ? "logged-out" : null);
      break;
    }
    case "loading-webgpu":
      // A slow WebGPU start on the first load (D-showcase-1).
      setLoading("Loading the game…", 0.02);
      setLoading(WEBGPU_SLOW_LINE, 0.05);
      break;
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
    case "og": {
      // The share image (public/og.jpg, 1200×630): an in-game still and the wordmark. Shoot this
      // screen at 1200×630 and save it as a JPEG.
      const og = el("div", "fl-ui fl-og", document.body);
      const img = el("img", "", og);
      img.alt = "";
      img.src = new URL("../stills/portus-plaza-dusk.webp", import.meta.url).href;
      const text = el("div", "fl-og__text", og);
      el("div", "fl-eyebrow", text, "An open world in your browser");
      const mark = el("div", "fl-wordmark fl-og__mark", text);
      mark.append("First");
      el("b", "", mark, "light");
      el("p", "", text, "Three planets, a hub, a crowd of strangers, one life. Free, no download.");
      break;
    }
    case "moment-level":
    case "moment-spell":
    case "moment-mission":
    case "moment-trial":
    case "moment-gleam":
    case "moment-vault":
    case "moment-medal":
      showMoment(quietHud(), MOMENTS[screen.slice(7)]!());
      break;
    case "arrival":
    case "arrival-portus":
    case "arrival-hollowmere":
    case "arrival-meridian": {
      const body = (screen.split("-")[1] ?? "arcadia") as BodyId;
      quietHud(body).moments.arrival(arrivalCard(body));
      break;
    }
    case "hud-full":
      fullHud(false);
      break;
    case "hud-combat":
      fullHud(true);
      break;
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
    case "save-unavailable":
    case "save-locked":
      hudScene("monster");
      void openSaveProgress({ name: "Wren_07", level: 2, starter: 3, later: "Esc → Save progress", preview: screen === "save" ? "email" : (screen.slice(5) as "code" | "saved" | "busy" | "unavailable" | "locked") });
      break;
    case "signin":
    case "signin-unavailable":
      gameEl.className = "fl-gallery-dark";
      void showSignIn({ preview: screen === "signin" ? "email" : "unavailable" });
      break;
    case "name":
      gameEl.className = "fl-gallery-dark";
      void pickDisplayName({ suggested: "Wanderer_ab12", dismissible: true });
      break;
    case "players": {
      gameEl.className = "fl-gallery-world";
      party();
      const list = new PlayerList({ players: () => PLAYERS as Map<string, any>, selfSession: () => "me", myPos: () => [0, 500, 0], bodyName: () => "Arcadia", send() {}, relock() {} });
      list.open();
      break;
    }
    case "compass": {
      const hud = hudScene("monster");
      const c = new Compass(hud.root);
      c.update([0, 500, 0], [0.6, 0, -0.8], "arcadia", false, [{ key: "u2", label: "Mossback", colour: "#7fe3b0", pos: [60, 490, -90] }]);
      break;
    }
    case "wheel": {
      hudScene("monster");
      const w = new PhraseWheel(() => {});
      const fakeInput = { mouseDX: 0, mouseDY: 0, sensitivity: 1, lmb: false } as unknown;
      (w as unknown as { show(i: unknown, now: number): void }).show(fakeInput, 0);
      (w as unknown as { select(i: number): void }).select?.(3);
      break;
    }
    case "shop":
    case "journal": {
      const hud = hudScene("monster");
      hud.you = you({ coins: 214, missions: [{ id: "A1", progress: 8, goal: 8, done: true }, { id: "A2", progress: 0, goal: 1, done: false }] });
      const g = { hud, input: { enabled: true, keys: new Set(), lock() {} }, net: { room: null }, bodyId: "arcadia" } as unknown as Game;
      if (screen === "shop") new ShopPanel(g).openAt(SHOP_SPOTS.find((s) => s.body === "arcadia")!);
      else new JournalPanel(g).show("missions");
      break;
    }
    case "invite":
      hudScene("monster");
      addInvite({ from: "u4", fromName: "Vexa_77", partyId: null, expiresAt: Date.now() + 30_000 });
      new InviteCards(() => {}).render();
      break;
    case "inventory":
    case "inventory-drag": {
      // The live inventory panel (I) with mock bags: hover a slot for its card, drag or click to move.
      const hud = hudScene("monster");
      hud.you = you({
        hotbar: [{ id: "carbine", tier: 2, qty: 1, mag: 21 }, { id: "stormcoil", tier: 3, qty: 1 }, null, { id: "tonic_small", tier: 1, qty: 4 }],
        backpack: [
          { id: "patchkit", tier: 1, qty: 2 }, { id: "wool_tuft", tier: 1, qty: 7 }, { id: "fox_mask", tier: 1, qty: 1 }, { id: "sunbrand", tier: 2, qty: 1 },
          { id: "radio", tier: 1, qty: 1 }, { id: "riverstaff", tier: 2, qty: 1, skin: "ferrymans_oar" }, { id: "travellers_cloak", tier: 1, qty: 1 }, { id: "bubble", tier: 1, qty: 1 },
          ...Array(8).fill(null),
        ],
        worn: { cape: "travellers_cloak" },
      });
      const g = { hud, input: { enabled: true, keys: new Set(), lock() {} }, net: { room: null }, bodyId: "arcadia" } as unknown as Game;
      const inv = new InventoryPanel(g);
      inv.open();
      inv.cursor.focus = 7; // the Sunbrand II in the backpack: card with a damage comparison
      if (screen === "inventory-drag") inv.cursor.click(4); // holding the Patchkit: drop zone armed
      inv.render();
      break;
    }
    case "onboarding":
    case "onboarding-attack":
    case "onboarding-loot":
    case "onboarding-portal":
    case "onboarding-done": {
      // The live onboarding HUD: step 4 (sprint, bar half full), the attack lesson with its way to a
      // dummy, the last tip (after the payout), or the end card with its way to the Arcadia portal.
      gameEl.className = "fl-gallery-world";
      const hud = new Hud();
      hud.setIdentity("Wren_07", 3, 0);
      hud.setYou(you({ level: 1, xp: 20, xpToNext: 50, coins: 0, hotbar: [{ id: "carbine", tier: 1, qty: 1, mag: 24 }, null, null, null] }));
      hud.setHp(100, 100);
      const onb = new OnboardingHud(hud.root.querySelector<HTMLElement>(".fl-hud__layer")!, () => {}, "https://github.com/example/firstlight", { expanded: q.has("expanded"), onExpanded: () => {} });
      const steps = new OnboardingSteps();
      const sample = { dt: 0, moved: 0, lookRad: 0, anim: ANIM.IDLE as number, trained: false, pressed: new Set<string>(), mapOpen: false, phrased: false, voiceOn: false, inPortal: false };
      for (const id of ["move", "look", "jump"] as const) steps.complete(id);
      steps.observe({ ...sample, dt: 1.1, anim: ANIM.SPRINT });
      if (screen !== "onboarding") for (const id of ["sprint", "dodge"] as const) steps.complete(id);
      if (screen === "onboarding-loot") for (const id of ["attack", "switch"] as const) steps.complete(id);
      if (screen === "onboarding-portal") for (const id of ["attack", "switch", "pickup", "map"] as const) steps.complete(id);
      onb.render(steps, screen === "onboarding-portal");
      if (screen === "onboarding-attack") onb.setWay({ label: "Training dummy", deg: -35, metres: 9 });
      if (screen === "onboarding-done") {
        onb.showDone(50);
        onb.setWay({ label: "Arcadia portal", deg: 60, metres: 24 });
      }
      break;
    }
    case "kit-inventory":
      hudScene("monster");
      document.getElementById("ui")!.insertAdjacentHTML("beforeend", INVENTORY_HTML);
      break;
    case "kit-onboarding": {
      gameEl.className = "fl-gallery-world";
      const hud = new Hud();
      hud.setIdentity("Wren_07", 3, 0);
      hud.setYou(you({ level: 1, coins: 0, hotbar: [{ id: "carbine", tier: 1, qty: 1, mag: 24 }, null, null, null] }));
      hud.setHp(100, 100);
      hud.root.querySelector(".fl-hud__layer")!.insertAdjacentHTML("beforeend", ONBOARDING_HTML);
      break;
    }
    case "removed":
      gameEl.className = "fl-gallery-world";
      showRemoved(4100);
      break;
    case "notice": {
      gameEl.className = "fl-gallery-world";
      new Menu(fakeGame(null)).showNotice("Playing elsewhere", "This character is playing in another tab or window.", "Play here", () => {});
      break;
    }
  }
}

void run();

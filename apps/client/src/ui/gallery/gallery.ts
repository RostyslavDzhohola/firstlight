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
import type { HomeData } from "@firstlight/shared/net/home";

const SCREENS = [
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

async function run() {
  const nav = el("nav", "fl-gallery-nav", document.body);
  if (q.has("nav")) for (const s of SCREENS) el("a", s === screen ? "is-on" : "", nav, s).setAttribute("href", `?screen=${s}&nav`);
  switch (screen) {
    case "landing":
    case "home-guest": {
      const m = /<section id="landing"[\s\S]*?<\/section>/.exec(indexHtml);
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
      // The live onboarding HUD: step 4 (sprint, bar half full), the dummies with their callout, the
      // final portal pointer (after the payout, with Star/Fork), or the end card.
      gameEl.className = "fl-gallery-world";
      const hud = new Hud();
      hud.setIdentity("Wren_07", 3, 0);
      hud.setYou(you({ level: 1, xp: 20, xpToNext: 50, coins: 0, hotbar: [{ id: "carbine", tier: 1, qty: 1, mag: 24 }, null, null, null] }));
      hud.setHp(100, 100);
      const onb = new OnboardingHud(hud.root.querySelector<HTMLElement>(".fl-hud__layer")!, () => {}, "https://github.com/example/firstlight", { expanded: q.has("expanded"), onExpanded: () => {} });
      const steps = new OnboardingSteps();
      const sample = { dt: 0, moved: 0, lookRad: 0, anim: ANIM.IDLE as number, dummiesDown: 0, pressed: new Set<string>(), phrased: false, voiceOn: false, atPortal: false, inPortal: false };
      for (const id of ["move", "look", "jump"] as const) steps.complete(id);
      steps.observe({ ...sample, dt: 1.1, anim: ANIM.SPRINT });
      if (screen !== "onboarding") for (const id of ["sprint", "dodge"] as const) steps.complete(id);
      if (screen === "onboarding-attack") steps.observe({ ...sample, dummiesDown: 1 });
      if (screen === "onboarding-loot") for (const id of ["attack", "switch"] as const) steps.complete(id);
      if (screen === "onboarding-portal") for (const id of ["attack", "switch", "pickup", "map", "wheel", "voice"] as const) steps.complete(id);
      onb.render(steps, screen === "onboarding-portal");
      if (screen === "onboarding-attack") onb.setCallout({ x: -0.18, y: 0.16, z: 0.5 }, "Training dummies · 1 / 3 down", "10 XP each. Three hits knock one down.");
      if (screen === "onboarding-portal") onb.setCallout({ x: -0.4, y: 0.1, z: 0.5 }, "Arcadia", "Levels 1–7 · walk in");
      if (screen === "onboarding-done") onb.showDone(50);
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

// Client side of quests and economy, created per body: world props and prompts (E), the shop,
// guide, journal (J), map (M) and keypad panels, the mission tracker, cosmetics on avatars, name
// and title plates, the Hall of Firsts wall, billboard lamps, and the admin console (`) with
// staged scenes (`stage <n>`, or `?stage=<n>` in the URL for an admin window).

import { EGG_BY_ID } from "@firstlight/shared/content/secrets";
import * as THREE from "three/webgpu";
import { PLANET_IDS, type BodyId } from "@firstlight/shared";
import type { HallLine } from "@firstlight/shared/content/secrets";
import { inReach, objectPos, objectsOn, surfaceDistance, type WorldObjectDef } from "@firstlight/shared/content/world";
import { PF } from "@firstlight/shared/net/schema";
import { flags } from "../config.ts";
import type { AvatarView } from "../render/Avatars.ts";
import { CosmeticRig, Nameplates } from "../render/Cosmetics.ts";
import { MapPanel } from "../ui/map.ts";
import { AdminConsole, GuidePanel, JournalPanel, KeypadPanel, MissionTracker, Panel, ShopPanel } from "../ui/panels.ts";
import { QuestWorld } from "../world/QuestWorld.ts";
import type { Game } from "./Game.ts";
import { HOTKEYS, hits } from "./keys.ts";
import type { ClientSystem } from "./systems.ts";

/** Survives body changes: the latest Hall of Firsts and a staged scene waiting for travel to finish. */
let hall: HallLine[] = [];
let pendingStage: { n: number; all: boolean } | null = null;
let urlStageSent = false;

const DENIED: Record<string, string> = {
  "fastTravel:stand on a pad": "Stand on a pad (inside its safe ring) to fast travel",
  "fastTravel:undiscovered": "You haven't discovered that pad yet — walk onto it once",
  "fastTravel:cooldown": "The pad is recharging — try again in a moment",
  "mission:too far": "Talk to the guide at the main pad to take missions",
  "mission:done this life": "You've done that mission in this life",
  "mission:active": "You're already on that mission",
  "mission:wrong planet": "That guide's missions are on another planet",
  "title:not earned": "You haven't earned that medal yet",
};

export class QuestClient implements ClientSystem {
  private readonly game: Game;
  private readonly world: QuestWorld;
  private readonly shop: ShopPanel;
  private readonly guide: GuidePanel | null;
  private readonly journal: JournalPanel;
  private readonly keypad: KeypadPanel;
  private readonly map: MapPanel;
  private readonly tracker: MissionTracker;
  private readonly plates = new Nameplates();
  private readonly console: AdminConsole;
  private readonly rigs = new Map<AvatarView, CosmeticRig>();
  private readonly interactables: { def: WorldObjectDef; pos: [number, number, number] }[];
  private lastYou: unknown = null;
  private t = 0;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  constructor(game: Game) {
    this.game = game;
    const body = game.bodyId;
    const terrain = game.planet.terrain;
    this.world = new QuestWorld(game.ctx.scene, body, terrain);
    this.world.setHall(hall);
    this.interactables = objectsOn(body)
      .filter((o) => o.trigger === "interact")
      .map((def) => ({ def, pos: objectPos(def, (x, y, z) => terrain.groundHeight(x, y, z)) }));
    this.shop = new ShopPanel(game);
    this.guide = (PLANET_IDS as readonly BodyId[]).includes(body) ? new GuidePanel(game, body as Exclude<BodyId, "portus">) : null;
    this.journal = new JournalPanel(game);
    this.keypad = new KeypadPanel(game);
    this.map = new MapPanel(game);
    this.tracker = new MissionTracker(game.hud);
    this.console = new AdminConsole(game);
    window.addEventListener("keydown", this.onKey);

    const room = game.net.room!;
    room.onMessage("hall", (m: { lines: HallLine[] }) => {
      hall = m.lines;
      this.world.setHall(hall);
    });
    room.onMessage("lamp", (m: { id: string; on: boolean }) => this.world.setLamp(m.id, m.on));
    room.onMessage("prompt", (m: { kind: string; target: string }) => {
      if (m.kind === "keypad") this.keypad.show(m.target);
    });
    room.onMessage("stage", (m: { n: number; body: BodyId }) => {
      pendingStage = { n: m.n, all: false };
      void this.game.travel(m.body);
    });
    room.onMessage("denied", (m: { action: string; reason: string }) => {
      const text = DENIED[`${m.action}:${m.reason}`];
      if (text) this.game.hud.toast(text, "warn");
    });
    for (const t of ["medal", "missionDone", "shop"]) room.onMessage(t, () => {});
    room.send("questSync", {});
    if (pendingStage) {
      room.send("admin", { cmd: "stage", args: { n: pendingStage.n, all: pendingStage.all } });
      pendingStage = null;
    }
  }

  private isAdmin(): boolean {
    const room = this.game.net.room;
    const me = (room?.state as any)?.players?.get(room?.sessionId ?? "");
    return !!me && (me.flags & PF.ADMIN) !== 0;
  }

  private key(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (this.game.combat.deadUntilRespawn || !this.game.net.room) return;
    if (hits(HOTKEYS.adminConsole, e.code, e.shiftKey) && this.isAdmin()) {
      e.preventDefault();
      this.console.toggle();
      return;
    }
    if (this.console.isOpen || Panel.current) return; // panels close themselves (Esc / their key)
    if (!this.game.input.locked || this.game.photo?.active) return;
    if (e.code === "KeyM") this.map.open();
    else if (e.code === "KeyJ") this.journal.show();
  }

  private pileNear(): boolean {
    const state = this.game.net.room?.state as any;
    let near = false;
    const p = this.game.player.pos;
    state?.piles?.forEach((pl: any) => {
      if (Math.hypot(p.x - pl.x, p.y - pl.y, p.z - pl.z) <= 3.2) near = true;
    });
    return near;
  }

  private nearestObject(active: Set<string>): WorldObjectDef | null {
    const p = this.game.player.pos;
    const at: [number, number, number] = [p.x, p.y, p.z];
    let best: WorldObjectDef | null = null;
    let bestD = Infinity;
    for (const o of this.interactables) {
      if (o.def.egg && EGG_BY_ID.get(o.def.egg)?.extra && !this.game.hud.you?.cosmeticsExtras) continue;
      if (o.def.mission && !active.has(o.def.mission)) continue;
      if (!inReach(o.pos, at, o.def.range, 0.3)) continue;
      const d = surfaceDistance(o.pos, at);
      if (d < bestD) {
        bestD = d;
        best = o.def;
      }
    }
    return best;
  }

  private promptFor(o: WorldObjectDef): string {
    if (o.look === "keeper") return "E — Trade with Juno Vale";
    if (o.look === "guide") return `E — Talk to ${o.name}`;
    return `E — ${o.name}`;
  }

  private use(o: WorldObjectDef) {
    if (o.look === "keeper") return this.shop.open();
    if (o.look === "guide") return this.guide?.open();
    if (o.look === "lantern" && o.egg === "E4") this.world.lightLantern(o.id);
    this.game.net.room?.send("interact", { target: o.id });
  }

  update(dt: number) {
    this.t += dt;
    const g = this.game;
    const you = g.hud.you;
    const active = new Set((you?.missions ?? []).filter((m) => !m.done).map((m) => m.id));
    this.world.update(dt, { activeMissions: active, cosmeticsExtras: !!you?.cosmeticsExtras });
    this.tracker.update(you);
    if (you !== this.lastYou) {
      this.lastYou = you;
      if (Panel.current && Panel.current !== this.map && Panel.current !== this.keypad) Panel.current.refresh();
    }

    // Prompts and E (piles win: the combat client picks those up).
    if (!g.combat.deadUntilRespawn && !Panel.current && !g.photo?.active && !this.pileNear()) {
      const o = this.nearestObject(active);
      if (o) {
        g.hud.setPrompt(this.promptFor(o));
        if (g.input.locked && g.input.pressed.has("KeyE")) this.use(o);
      }
    }

    // A window opened with ?stage=<n> stages itself once the admin flag is known.
    const stageFlag = flags.get("stage");
    if (stageFlag && !urlStageSent && this.isAdmin()) {
      urlStageSent = true;
      g.net.room?.send("admin", { cmd: "stage", args: { n: Number(stageFlag), all: flags.has("all") } });
    }

    this.syncAvatars();
  }

  private rig(avatar: AvatarView): CosmeticRig {
    let r = this.rigs.get(avatar);
    if (!r) {
      r = new CosmeticRig(avatar);
      this.rigs.set(avatar, r);
    }
    return r;
  }

  private syncAvatars() {
    const g = this.game;
    const room = g.net.room;
    const players = (room?.state as any)?.players;
    if (!room || !players) return;
    const mine = players.get(room.sessionId);
    if (g.self && mine) this.rig(g.self).set(mine.cosmetics ?? "");
    const live = new Set<AvatarView>(g.self ? [g.self] : []);
    const plates: { id: string; pos: THREE.Vector3; name: string; title: string }[] = [];
    for (const [id, a] of g.avatars) {
      const st = players.get(id);
      if (!st) continue;
      live.add(a);
      this.rig(a).set(st.cosmetics ?? "");
      if (!(st.flags & PF.DEAD)) plates.push({ id, pos: a.root.position, name: st.name, title: st.title ?? "" });
    }
    for (const [avatar, r] of this.rigs) {
      if (live.has(avatar)) r.update(this.t);
      else {
        r.dispose();
        this.rigs.delete(avatar);
      }
    }
    this.plates.update(g.ctx.camera, plates, g.player.pos);
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    Panel.current?.close(false);
    this.console.close();
    this.world.dispose();
    this.tracker.dispose();
    this.plates.dispose();
    for (const r of this.rigs.values()) r.dispose();
    this.rigs.clear();
  }
}

export function createQuestClient(game: Game): ClientSystem | null {
  return game.net.room ? new QuestClient(game) : null;
}

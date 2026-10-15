// The social layer on the client: compass strip, player list (Tab), party invites (Y/N), screenshot
// (P / button). Created once per game; `attachRoom()` makes the per-room client system after every
// join (room message handlers, the analytics hello, the session→account resolver).

import { BODIES } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import type { PartyInviteMsg, PartyStateMsg } from "@firstlight/shared/net/social";
import type { Room } from "@colyseus/sdk";
import type { ClientSystem } from "../game/systems.ts";
import type { Game } from "../game/Game.ts";
import { HOTKEYS, hits } from "../game/keys.ts";
import { Compass, PARTY_COLOURS, type CompassMarker } from "./compass.ts";
import { el, typing } from "./dom.ts";
import { InviteCards } from "./invites.ts";
import { PlayerList } from "./playerList.ts";
import { noteRemovalReason } from "./screens.ts";
import { CAMERA_ICON, captureShot, flash, shareDialog } from "./screenshot.ts";
import { addInvite, onSocialChange, partyState, removeInvite, setBlockedList, setParty, setSessionResolver } from "./store.ts";
import type { V3 } from "./compassMath.ts";
import { partyFrames } from "../ui/partyFrames.ts";
import { waypoints } from "../ui/waypoint.ts";
import { voice } from "../voice/index.ts";

const PEEK_MS = 250;

export class SocialUi {
  readonly compass: Compass;
  readonly list: PlayerList;
  readonly invites: InviteCards;
  private readonly shotBtn: HTMLButtonElement;
  private tabDownAt = 0;
  private shooting = false;
  private partyAt = 0;

  constructor(private readonly game: Game) {
    this.compass = new Compass(game.hud.root);
    this.list = new PlayerList({
      players: () => (this.room()?.state as any)?.players ?? null,
      selfSession: () => this.room()?.sessionId ?? "",
      myPos: () => {
        const p = this.game.player.pos;
        return [p.x, p.y, p.z];
      },
      bodyName: () => BODIES[this.game.bodyId].name,
      send: (type, msg) => this.room()?.send(type, msg),
      relock: () => this.game.input.lock(),
    });
    this.invites = new InviteCards((inv, accept) => this.room()?.send("party", { action: accept ? "accept" : "decline", target: inv.from }));
    this.shotBtn = el("button", "fl-shot-btn", game.hud.root);
    this.shotBtn.type = "button";
    this.shotBtn.title = "Screenshot (P)";
    this.shotBtn.setAttribute("aria-label", "Take a screenshot");
    this.shotBtn.innerHTML = CAMERA_ICON;
    this.shotBtn.onclick = () => void this.screenshot();
    onSocialChange(() => {
      this.list.refresh();
      this.invites.render();
    });
    window.addEventListener("keydown", (e) => this.keyDown(e));
    window.addEventListener("keyup", (e) => this.keyUp(e));
  }

  private room(): Room | null {
    return this.game.net.room;
  }

  /** The per-room client system (created by CLIENT_SYSTEMS after each join). */
  attachRoom(): ClientSystem | null {
    const room = this.room();
    if (!room) return null;
    const state = () => (room.state as any)?.players as Map<string, any> | undefined;
    setSessionResolver((sid) => state()?.get(sid)?.userId || undefined, () => state()?.get(room.sessionId)?.userId ?? "");
    room.onMessage("party:state", (m: PartyStateMsg) => setParty(m));
    room.onMessage("party:invite", (m: PartyInviteMsg) => {
      addInvite(m);
      this.game.hud.toast(`${m.fromName} invited you to a party — Y to accept, N to decline`, "info");
    });
    room.onMessage("party:invite-closed", (m: { from: string; to: string; reason: string }) => {
      if (m.reason === "expired" || m.reason === "cancelled") removeInvite(m.from);
    });
    room.onMessage("social:blocked", (m: { userIds: string[] }) => setBlockedList(m.userIds));
    room.onMessage("kicked", (m: { reason: string }) => noteRemovalReason(m.reason));
    room.onMessage("denied", (m: { action: string; reason: string }) => {
      if (["party", "mod", "block", "report"].includes(m.action)) this.game.hud.toast(m.reason[0]!.toUpperCase() + m.reason.slice(1), "warn");
    });
    // Analytics hello; the server answers with the party, block list and pending invites.
    room.send("client:info", { backend: this.game.ctx.webgpu ? "webgpu" : "webgl2", tier: this.game.ctx.tier });
    return {
      update: (_dt, now) => this.update(now),
      dispose: () => {
        if (this.list.isOpen) this.list.close(false);
        this.compass.setVisible(false);
      },
    };
  }

  private update(now: number) {
    const room = this.room();
    if (!room) return;
    const players = (room.state as any)?.players as Map<string, any> | undefined;
    const me = players?.get(room.sessionId);
    const p = this.game.player.pos;
    const f = this.game.player.camForward;
    const pos: V3 = [p.x, p.y, p.z];
    const markers: CompassMarker[] = [];
    const party = partyState();
    party.members.forEach((m, i) => {
      if (m.userId === me?.userId || !m.online || m.body !== this.game.bodyId) return;
      const here = m.roomId === room.roomId && m.sessionId ? players?.get(m.sessionId) : null;
      const at: V3 | null = here ? [here.x, here.y, here.z] : m.x || m.y || m.z ? [m.x, m.y, m.z] : null;
      if (at) markers.push({ key: m.userId, label: m.name, colour: PARTY_COLOURS[i % PARTY_COLOURS.length]!, pos: at });
    });
    this.compass.update(pos, [f.x, f.y, f.z], this.game.bodyId, !!me && (me.flags & PF.SAFE) !== 0, markers, waypoints.get(this.game.bodyId));
    // HUD party frames (top-left), 4 Hz.
    if (now - this.partyAt > 250) {
      this.partyAt = now;
      const peers = new Map((voice()?.peers() ?? []).map((v) => [v.id, v]));
      const frames = partyFrames(party.members, me ?? null, players ?? null, this.game.bodyId, (sid) => {
        const v = peers.get(sid);
        return v ? { speaking: v.speaking > 0.06, radio: v.radioTx, muted: v.muted || v.blocked || v.adminMuted } : null;
      });
      this.game.hud.setParty(frames);
    }
    this.list.update(now);
    this.invites.render();
  }

  // ---- keys ---------------------------------------------------------------------------------------

  private inWorld(): boolean {
    return !!this.room() && !this.shooting && !this.game.input.suspended; // not behind a loading screen
  }

  private keyDown(e: KeyboardEvent) {
    if (typing(e) || !this.inWorld()) return;
    if (e.code === "Tab") {
      e.preventDefault();
      if (e.repeat) return;
      if (!this.list.isOpen) {
        this.tabDownAt = performance.now();
        if (this.game.input.locked) this.list.peek();
        else this.list.open();
      } else if (this.list.interactive) this.list.close(true);
      return;
    }
    if (e.repeat) return;
    if (e.code === "Escape" && this.list.isOpen) {
      this.list.close(true); // back into the game (the list freed the pointer itself)
      return;
    }
    if (hits(HOTKEYS.screenshot, e.code, e.shiftKey) && !e.metaKey && !e.ctrlKey) {
      void this.screenshot();
      return;
    }
    if ((e.code === "KeyY" || e.code === "KeyN") && this.invites.current()) {
      this.invites.respond(e.code === "KeyY");
    }
  }

  private keyUp(e: KeyboardEvent) {
    if (e.code !== "Tab" || !this.list.isOpen || this.list.interactive) return;
    // A tap opens the list with the mouse free; a hold was just a peek.
    if (performance.now() - this.tabDownAt < PEEK_MS) this.list.open();
    else this.list.close(false);
  }

  // ---- screenshot ---------------------------------------------------------------------------------

  async screenshot() {
    const room = this.room();
    if (!room || this.shooting) return;
    this.shooting = true;
    const wasLocked = this.game.input.locked;
    try {
      if (this.list.isOpen) this.list.close(false);
      const me = (room.state as any)?.players?.get(room.sessionId);
      const info = { name: me?.name || "Wanderer", level: me?.level ?? 1, planet: BODIES[this.game.bodyId].name };
      const { blob, blank } = await captureShot({ canvas: this.game.ctx.renderer.domElement, render: () => this.game.ctx.render() }, info);
      flash();
      shareDialog(blob, info, blank, () => {
        this.shooting = false;
        if (wasLocked) this.game.input.lock();
      });
      document.exitPointerLock?.();
    } catch (err) {
      console.warn("screenshot failed", err);
      this.game.hud.toast("Couldn't take a screenshot here", "warn");
      this.shooting = false;
    }
  }
}

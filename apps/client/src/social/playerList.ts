// Player list (Tab): everyone in this world copy with level, character, party and voice state.
// Tap Tab to open it with the mouse (actions), hold Tab to peek. Actions: mute (local), block,
// invite to party (30 m), report; admins also kick, ban, voice-mute, go to, bring and announce.

import { STARTERS } from "@firstlight/shared/content/weapons";
import { PF } from "@firstlight/shared/net/schema";
import { REPORT_REASONS, SOCIAL } from "@firstlight/shared/net/social";
import { el, isolateKeys, sbtn } from "./dom.ts";
import { PARTY_COLOURS } from "./compass.ts";
import { isBlocked, isMutedLocally, partyState, setMuted } from "./store.ts";

export interface ListHost {
  /** Room state players map (sessionId → PlayerState), and my session id. */
  players(): Map<string, any> | null;
  selfSession(): string;
  myPos(): [number, number, number];
  bodyName(): string;
  send(type: string, msg: unknown): void;
  /** Re-lock the pointer (closing with Tab). */
  relock(): void;
}

type Mode = "closed" | "peek" | "open";

export class PlayerList {
  private mode: Mode = "closed";
  private overlay: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private reportFor: string | null = null;
  private confirmBan: { sid: string; until: number } | null = null;
  private lastRender = 0;

  constructor(private readonly host: ListHost) {}

  get isOpen() {
    return this.mode !== "closed";
  }

  get interactive() {
    return this.mode === "open";
  }

  peek() {
    if (this.mode !== "closed") return;
    this.mode = "peek";
    this.build();
  }

  open() {
    const wasClosed = this.mode === "closed";
    this.mode = "open";
    if (wasClosed) this.build();
    else this.overlay?.classList.remove("peek");
    // Our overlay (an .fl-overlay with an h2) is in the DOM first, so the pause menu stays away.
    document.exitPointerLock?.();
    this.render(true);
  }

  close(relock: boolean) {
    if (this.mode === "closed") return;
    this.mode = "closed";
    this.reportFor = null;
    this.confirmBan = null;
    this.overlay?.remove();
    this.overlay = this.panel = null;
    if (relock) this.host.relock();
  }

  /** Re-render periodically while open (positions, joins, leaves), but not while typing a report. */
  update(now: number) {
    if (this.mode === "closed" || now - this.lastRender < 400) return;
    if (this.panel?.contains(document.activeElement) && document.activeElement?.tagName !== "BUTTON") return;
    this.render(false);
  }

  refresh() {
    if (this.mode !== "closed") this.render(true);
  }

  private build() {
    this.overlay = el("div", `fl-overlay fl-plist${this.mode === "peek" ? " peek" : ""}`);
    this.panel = el("div", "fl-panel", this.overlay);
    isolateKeys(this.panel);
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close(false);
      else if (e.code === "Tab") {
        e.preventDefault();
        this.close(true);
      }
    });
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close(true);
    });
    document.body.appendChild(this.overlay);
    this.render(true);
  }

  private render(force: boolean) {
    const panel = this.panel;
    if (!panel) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 400) return;
    this.lastRender = now;
    const players = this.host.players();
    const selfSid = this.host.selfSession();
    const self = players?.get(selfSid);
    const iAmAdmin = !!self && (self.flags & PF.ADMIN) !== 0;
    const party = partyState();
    const myParty = party.id;
    const partyFull = party.members.length >= SOCIAL.PARTY_MAX;
    const iLead = !!myParty && party.leader === self?.userId;
    const [mx, my, mz] = this.host.myPos();
    const interactive = this.mode === "open";

    panel.replaceChildren();
    el("h2", "", panel, "PLAYERS");
    el("p", "sub", panel, `${players?.size ?? 0} in this copy of ${this.host.bodyName()} · ${interactive ? "Tab or Esc to close" : "tap Tab for actions"}`);

    // ---- party
    if (myParty) {
      el("h3", "", panel, `Your party (${party.members.length}/${SOCIAL.PARTY_MAX})`);
      const t = el("table", "", panel);
      party.members.forEach((m, i) => {
        const tr = el("tr", m.userId === self?.userId ? "me" : "", t);
        const name = el("td", "", tr);
        const dot = el("span", "", name);
        dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:${PARTY_COLOURS[i % PARTY_COLOURS.length]}`;
        el("span", "nm", name, m.name);
        if (m.userId === party.leader) el("span", "fl-chip party", name, "LEADER");
        el("td", "num", tr, m.online && m.level ? `LV ${m.level}` : "");
        el("td", "", tr, m.online ? (m.body ? m.body[0]!.toUpperCase() + m.body.slice(1) : "") : "offline");
        const acts = el("div", "acts", el("td", "", tr));
        if (!interactive) return;
        if (m.userId === self?.userId) sbtn("Leave party", () => this.host.send("party", { action: "leave" }), "warn", acts);
        else if (iLead) sbtn("Remove", () => this.host.send("party", { action: "kick", target: m.userId }), "warn", acts);
      });
    }

    // ---- everyone here
    el("h3", "", panel, "In this world copy");
    const table = el("table", "", panel);
    const head = el("tr", "", table);
    for (const h of ["Player", "Level", "Character", "Voice", "Distance", ""]) el("th", h === "Level" || h === "Distance" ? "num" : "", head, h);
    const rows = [...(players?.entries() ?? [])].sort(([a, pa], [b, pb]) => (a === selfSid ? -1 : b === selfSid ? 1 : String(pa.name).localeCompare(String(pb.name))));
    for (const [sid, p] of rows) {
      const me = sid === selfSid;
      const tr = el("tr", me ? "me" : "", table);
      const name = el("td", "", tr);
      el("span", "nm", name, p.name || "Wanderer");
      if (p.title) el("span", "ttl", name, p.title);
      if (me) el("span", "fl-chip", name, "YOU");
      if (p.flags & PF.ADMIN) el("span", "fl-chip admin", name, "ADMIN");
      if (p.party) el("span", `fl-chip ${p.party === myParty ? "party" : "other"}`, name, p.party === myParty ? "PARTY" : "IN A PARTY");
      if (p.flags & PF.DEAD) el("span", "fl-chip bad", name, "DEAD");
      if (isBlocked(sid)) el("span", "fl-chip bad", name, "BLOCKED");
      el("td", "num", tr, String(p.level));
      el("td", "", tr, STARTERS[p.starter]?.name ?? "");
      const voice = p.flags & PF.VOICE_MUTED ? ["muted", "admin-muted"] : isMutedLocally(sid) ? ["muted", "muted by you"] : p.flags & PF.VOICE ? ["live", "voice on"] : ["", "voice off"];
      el("td", `fl-voice ${voice[0]}`, tr, voice[1]);
      const d = Math.hypot(p.x - mx, p.y - my, p.z - mz);
      el("td", "num", tr, me ? "" : `${Math.round(d)} m`);
      const cell = el("td", "", tr);
      if (!interactive || me) continue;

      if (this.reportFor === sid) {
        this.reportPicker(cell, sid, String(p.name));
        continue;
      }
      const acts = el("div", "acts", cell);
      const muted = isMutedLocally(sid);
      sbtn(muted ? "Unmute" : "Mute", () => {
        setMuted(sid, !muted);
        this.render(true);
      }, muted ? "on" : "", acts, "Mute their voice for you only");
      const blocked = isBlocked(sid);
      sbtn(blocked ? "Unblock" : "Block", () => this.host.send("social:block", { target: p.userId || sid, on: !blocked }), blocked ? "on" : "", acts, "No voice or invites between you, kept on your account");
      if (p.party !== myParty || !myParty) {
        const why = blocked ? "blocked" : d > SOCIAL.INVITE_RANGE_M ? "get within 30 m" : partyFull ? "your party is full" : "";
        const inv = sbtn("Invite", () => this.host.send("party", { action: "invite", target: sid }), "", acts, why || "Invite to your party");
        inv.disabled = !!why;
      }
      sbtn("Report", () => {
        this.reportFor = sid;
        this.render(true);
      }, "", acts);
      if (iAmAdmin) {
        const mod = el("span", "mod", acts);
        sbtn("Go to", () => this.host.send("mod", { action: "goto", target: sid }), "", mod);
        sbtn("Bring", () => this.host.send("mod", { action: "bring", target: sid }), "", mod);
        const vm = (p.flags & PF.VOICE_MUTED) !== 0;
        sbtn(vm ? "Voice on" : "Voice off", () => this.host.send("mod", { action: "voicemute", target: sid, on: !vm }), vm ? "on" : "", mod, "Admin voice-mute");
        sbtn("Kick", () => this.host.send("mod", { action: "kick", target: sid }), "warn", mod);
        const confirming = this.confirmBan?.sid === sid && this.confirmBan.until > Date.now();
        sbtn(confirming ? "Confirm ban" : "Ban", () => {
          if (confirming) {
            this.host.send("mod", { action: "ban", target: sid });
            this.confirmBan = null;
          } else this.confirmBan = { sid, until: Date.now() + 4000 };
          this.render(true);
        }, confirming ? "primary" : "warn", mod, "Ban the account and its network");
      }
    }

    if (interactive && iAmAdmin) {
      const foot = el("div", "foot", panel);
      el("span", "", foot, "Announce to everyone:");
      const input = el("input", "", foot);
      input.type = "text";
      input.maxLength = 200;
      input.placeholder = "Banner text";
      const send = () => {
        if (!input.value.trim()) return;
        this.host.send("mod", { action: "announce", text: input.value.trim() });
        input.value = "";
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send();
      });
      sbtn("Send", send, "primary", foot);
    }
  }

  private reportPicker(cell: HTMLElement, sid: string, name: string) {
    const box = el("div", "report", cell);
    el("span", "", box, `Report ${name}:`);
    const select = el("select", "", box);
    for (const r of REPORT_REASONS) {
      const o = el("option", "", select, r[0]!.toUpperCase() + r.slice(1));
      o.value = r;
    }
    const note = el("input", "", box);
    note.type = "text";
    note.maxLength = 200;
    note.placeholder = "What happened? (optional)";
    sbtn("Send", () => {
      this.host.send("report", { target: sid, reason: select.value, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
      this.reportFor = null;
      this.render(true);
    }, "primary", box);
    sbtn("Cancel", () => {
      this.reportFor = null;
      this.render(true);
    }, "", box);
    setTimeout(() => select.focus(), 0);
  }
}

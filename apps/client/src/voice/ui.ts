// Voice UI, plain DOM (D25): the HUD mic widget (state, self mic meter, radio line with the
// transmitting speaker's name), speaking rings over heads, and the "Voice & radio" panel (opt-in with
// the 16+ declaration; then mutes, block, report, mute strangers, panic, radio channel picker).

import "./voice.css";
import * as THREE from "three/webgpu";
import { PF } from "@firstlight/shared/net/schema";
import { VOICE, VOICE_REPORT_REASONS } from "@firstlight/shared/net/voice";
import type { Game } from "../game/Game.ts";
import type { VoiceClient, VoicePeerInfo } from "./VoiceClient.ts";

const SPEAKING = 0.06;
const MIC_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>`;
const RADIO_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2h2v4h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1zm1 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm6 0v2h4v-2zm0 4v2h4v-2z"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const _p = new THREE.Vector3();

export class VoiceUi {
  private readonly vc: VoiceClient;
  private readonly root = el("div", "fl-voice");
  private readonly widget = el("div", "fl-vwidget", this.root);
  private readonly micIcon = el("span", "ic", this.widget);
  private readonly label = el("span", "lbl", this.widget);
  private readonly meter = el("span", "meter", this.widget);
  private readonly meterFill = el("i", "", this.meter);
  private readonly radioLine = el("div", "fl-vradio", this.root);
  private readonly rings = el("div", "fl-vrings", this.root);
  private readonly ringEls = new Map<string, HTMLDivElement>();
  private panel: { overlay: HTMLDivElement; body: HTMLDivElement; timer: number } | null = null;
  private reportFor: string | null = null;
  private blockConfirm: string | null = null;
  private reportReason: string = VOICE_REPORT_REASONS[0];
  private lastWidget = 0;

  constructor(vc: VoiceClient) {
    this.vc = vc;
    document.body.appendChild(this.root);
    this.micIcon.innerHTML = MIC_SVG;
    this.widget.title = "Voice & radio";
    this.widget.setAttribute("role", "button");
    this.widget.onclick = () => this.openPanel();
    this.refresh();
  }

  // ---------------------------------------------------------------- HUD

  /** Every frame: rings over speaking heads, the self meter, the radio line (text at ~10 Hz). */
  frame(game: Game, state: any, me: string): void {
    const vc = this.vc;
    const now = performance.now();
    const talking = vc.ptt || vc.radioTx;
    const level = vc.micState === "live" && (talking || vc.micTest) ? (vc.audio?.micLevel() ?? 0) : 0;
    this.meterFill.style.transform = `scaleX(${level.toFixed(3)})`;
    if (now - this.lastWidget > 100) {
      this.lastWidget = now;
      this.renderWidget(state, me);
    }
    this.renderRings(game, state);
  }

  private renderWidget(state?: any, me?: string): void {
    const vc = this.vc;
    let text: string;
    let cls: string;
    if (!vc.enabled) {
      text = vc.optedIn ? "Voice off · press V" : "Voice off · press V to set up";
      cls = "off";
    } else if (vc.adminMuted) {
      text = "Muted by a moderator";
      cls = "warn";
    } else if (vc.relayDown) {
      text = "Voice relay unavailable";
      cls = "warn";
    } else if (vc.panic) {
      text = "Everyone muted · Esc → Voice";
      cls = "warn";
    } else if (vc.radioTx) {
      text = `Radio · channel ${vc.myRadioCh()}`;
      cls = "talking radio";
    } else if (vc.ptt) {
      text = "Talking";
      cls = "talking";
    } else if (vc.micState !== "live") {
      text = "Listening only · no mic";
      cls = "on";
    } else {
      const n = vc.room?.transport.peers().length ?? 0;
      text = n ? `Hold V to talk · ${n} nearby` : "Hold V to talk";
      cls = "on";
    }
    this.label.textContent = text;
    this.widget.className = `fl-vwidget ${cls}`;

    // Radio line: only when you own a radio.
    const hasRadio = vc.hasRadio();
    this.radioLine.style.display = hasRadio ? "flex" : "none";
    if (!hasRadio) return;
    const ch = vc.myRadioCh();
    const speakers: string[] = [];
    if (ch && state?.players) {
      state.players.forEach((p: any, id: string) => {
        if (id !== me && p.radioCh === ch && p.flags & PF.RADIO_TX && !vc.blockedUsers.has(p.userId)) speakers.push(p.name);
      });
    }
    this.radioLine.className = `fl-vradio${speakers.length ? " rx" : ""}${vc.radioTx ? " tx" : ""}`;
    this.radioLine.innerHTML = RADIO_SVG;
    const t = el("span", "", this.radioLine);
    if (!ch) t.textContent = "Radio off · tune in Esc → Voice";
    else if (vc.radioTx) t.textContent = `CH ${ch} · transmitting`;
    else if (speakers.length) t.textContent = `CH ${ch} · ${speakers.join(", ")}`;
    else t.textContent = `CH ${ch} · hold B to talk`;
  }

  private renderRings(game: Game, state: any): void {
    const vc = this.vc;
    const cam = game.ctx.camera;
    const seen = new Set<string>();
    const myParty: string = state?.players?.get(game.net.room?.sessionId ?? "")?.party ?? "";
    if (vc.enabled && !vc.panic) {
      for (const [id, level] of vc.speaking) {
        if (level < SPEAKING) continue;
        const p = state?.players?.get(id);
        if (!p) continue;
        const av = game.avatars.get(id);
        if (av) _p.copy(av.root.position);
        else _p.set(p.x, p.y, p.z);
        const dist = _p.distanceTo(game.player.pos);
        if (dist > VOICE.DROP) continue;
        const len = _p.length() || 1;
        _p.addScaledVector(_p.clone().divideScalar(len), 2.25).project(cam);
        if (_p.z > 1 || Math.abs(_p.x) > 1.1 || Math.abs(_p.y) > 1.1) continue;
        let r = this.ringEls.get(id);
        if (!r) {
          r = el("div", "fl-vring", this.rings);
          this.ringEls.set(id, r);
        }
        seen.add(id);
        const muted = vc.mutedUsers.has(p.userId) || (vc.muteStrangers && !(myParty && p.party === myParty));
        r.classList.toggle("muted", muted);
        r.classList.toggle("radio", !!(p.flags & PF.RADIO_TX));
        const x = (_p.x * 0.5 + 0.5) * innerWidth;
        const y = (-_p.y * 0.5 + 0.5) * innerHeight;
        const s = Math.max(0.55, Math.min(1.2, 14 / Math.max(4, dist))) * (1 + level * 0.5);
        r.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${s.toFixed(3)})`;
      }
    }
    for (const [id, r] of this.ringEls) {
      if (seen.has(id)) continue;
      r.remove();
      this.ringEls.delete(id);
    }
  }

  clearRings(): void {
    for (const r of this.ringEls.values()) r.remove();
    this.ringEls.clear();
  }

  /** Re-render now (state changed). */
  refresh(): void {
    this.renderWidget();
    if (this.panel) this.renderPanel();
  }

  // ---------------------------------------------------------------- panel

  get panelOpen(): boolean {
    return !!this.panel;
  }

  openPanel(): void {
    if (this.panel) return;
    const overlay = el("div", "fl-overlay fl-vpanel-overlay");
    const box = el("div", "fl-panel fl-vpanel", overlay);
    const body = el("div", "", box);
    document.body.appendChild(overlay);
    overlay.addEventListener("keydown", (e) => e.stopPropagation());
    this.panel = { overlay, body, timer: window.setInterval(() => this.renderPeople(), 500) };
    this.vc.micTest = this.vc.enabled;
    document.exitPointerLock?.();
    this.renderPanel();
  }

  closePanel(resume = true): void {
    if (!this.panel) return;
    clearInterval(this.panel.timer);
    this.panel.overlay.remove();
    this.panel = null;
    this.reportFor = null;
    this.vc.micTest = false;
    if (resume) this.vc.game.input.lock();
  }

  private button(parent: HTMLElement, text: string, fn: () => void, cls = "ghost"): HTMLButtonElement {
    const b = el("button", `fl-btn ${cls}`, parent, text);
    b.onclick = fn;
    return b;
  }

  private renderPanel(): void {
    if (!this.panel) return;
    const body = this.panel.body;
    body.innerHTML = "";
    if (this.vc.enabled) this.renderSettings(body);
    else this.renderOptIn(body);
  }

  private renderOptIn(body: HTMLElement): void {
    const vc = this.vc;
    el("h2", "", body, "PROXIMITY VOICE");
    const list = el("ul", "fl-vfacts", body);
    el("li", "", list, "Talk to players near you. Voices come from where people stand and fade out by 35 m. With a radio you can talk to your channel anywhere on this planet.");
    el("li", "", list, "Hold V to talk. Hold B to talk on the radio. Nothing is sent while you aren't holding a key.");
    el("li", "", list, "Voice is never recorded. Audio goes through a relay, so other players never see your IP address.");
    el("li", "", list, "Mute, block or report anyone from Esc → Voice & radio. Shift+Esc mutes everyone at once.");
    const label = el("label", "fl-vcheck", body);
    const box = el("input", "", label);
    box.type = "checkbox";
    box.checked = vc.optedIn;
    el("span", "", label, "I'm 16 or older");
    const row = el("div", "fl-vrow", body);
    const enable = this.button(row, "Enable voice", () => {
      if (!box.checked) return;
      enable.disabled = true;
      // AudioContext.resume() and getUserMedia() run inside this click (Safari needs the gesture).
      void vc.enableFromGesture().then(() => this.renderPanel());
    }, "");
    enable.disabled = !box.checked;
    box.onchange = () => (enable.disabled = !box.checked);
    this.button(row, "Not now", () => this.closePanel());
    el("p", "fl-vsmall", body, "Your browser will ask for the microphone. If you say no, you can still listen.");
  }

  private renderSettings(body: HTMLElement): void {
    const vc = this.vc;
    el("h2", "", body, "VOICE & RADIO");
    const status = el("p", "fl-vstatus", body);
    if (vc.adminMuted) status.textContent = "A moderator muted your voice. You can't talk or hear others in this world.";
    else if (vc.relayDown) status.textContent = "The voice relay is unavailable right now. Retrying…";
    else if (vc.micState === "live") status.textContent = "Microphone ready. Hold V to talk to people near you.";
    else {
      status.textContent = vc.micState === "unsupported" ? "This browser can't use a microphone here. You can still listen." : "Microphone blocked — listening only. Allow the microphone in the address bar, then retry.";
      if (vc.micState === "denied") this.button(body, "Retry microphone", () => vc.retryMic());
    }
    if (vc.micState === "live") {
      const m = el("div", "fl-vmeter", body);
      el("span", "", m, "Mic test");
      const bar = el("span", "bar", m);
      const fill = el("i", "", bar);
      const tick = () => {
        if (!this.panel || !fill.isConnected) return;
        fill.style.transform = `scaleX(${(vc.audio?.micLevel() ?? 0).toFixed(3)})`;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    const toggles = el("div", "fl-vtoggles", body);
    const toggle = (text: string, on: boolean, fn: (v: boolean) => void) => {
      const l = el("label", "fl-vcheck", toggles);
      const i = el("input", "", l);
      i.type = "checkbox";
      i.checked = on;
      i.onchange = () => fn(i.checked);
      el("span", "", l, text);
    };
    toggle("Mute strangers (hear only your party)", vc.muteStrangers, (v) => vc.setMuteStrangers(v));
    toggle("Mute everyone (Shift+Esc)", vc.panic, (v) => vc.setPanic(v));

    // Radio channel picker.
    const radio = el("div", "fl-vradio-pick", body);
    el("b", "", radio, "Radio");
    if (vc.hasRadio()) {
      const cur = vc.myRadioCh();
      for (let ch = 0; ch <= VOICE.CHANNELS; ch++) {
        const b = el("button", `ch${ch === cur ? " sel" : ""}`, radio, ch === 0 ? "Off" : String(ch));
        b.onclick = () => vc.tune(ch);
      }
      el("span", "fl-vsmall", radio, "Hold B to talk on your channel (8 radios per channel).");
    } else {
      el("span", "fl-vsmall", radio, "Buy a radio in Portus (100 coins) to talk on channels 1–9 from anywhere on a planet.");
    }

    el("h3", "", body, "People here");
    el("div", "fl-vpeople", body);
    this.renderPeople();

    const row = el("div", "fl-vrow", body);
    this.button(row, "Close", () => this.closePanel(), "");
    this.button(row, "Turn voice off", () => vc.disable());
    el("p", "fl-vsmall", body, "Voice is never recorded. A report sends who, when and where — never audio. Blocks last across sessions.");
  }

  private renderPeople(): void {
    if (!this.panel) return;
    const list = this.panel.body.querySelector<HTMLDivElement>(".fl-vpeople");
    if (!list) return;
    // Keep the open report form intact.
    if (this.reportFor && list.querySelector("select")) return;
    const vc = this.vc;
    const admin = vc.isAdmin();
    list.innerHTML = "";
    const peers = vc.peers();
    if (!peers.length) {
      el("p", "fl-vsmall", list, "Nobody else is in this world copy right now.");
      return;
    }
    for (const p of peers.slice(0, 40)) this.renderPerson(list, p, admin);
  }

  private renderPerson(list: HTMLElement, p: VoicePeerInfo, admin: boolean): void {
    const vc = this.vc;
    const row = el("div", `fl-vperson${p.speaking > SPEAKING ? " speaking" : ""}`, list);
    el("i", "dot", row);
    el("span", "name", row, p.name);
    const where = p.blocked ? "blocked" : !p.voice ? "voice off" : p.adminMuted ? "muted by mod" : p.radioCh && p.radioCh === vc.myRadioCh() && p.dist > VOICE.CONNECT ? `radio · ${Math.round(p.dist)} m` : `${Math.round(p.dist)} m`;
    el("span", "meta", row, `${where}${p.party ? " · party" : ""}`);
    const actions = el("span", "acts", row);
    if (this.reportFor === p.id) {
      const sel = el("select", "", actions);
      for (const r of VOICE_REPORT_REASONS) {
        const o = el("option", "", sel, r);
        o.value = r;
        if (r === this.reportReason) o.selected = true;
      }
      sel.onchange = () => (this.reportReason = sel.value);
      const send = el("button", "", actions, "Send");
      send.onclick = () => {
        vc.report(p.id, this.reportReason);
        this.reportFor = null;
        this.renderPeople();
      };
      const cancel = el("button", "", actions, "Cancel");
      cancel.onclick = () => {
        this.reportFor = null;
        this.renderPeople();
      };
      return;
    }
    if (!p.blocked) {
      const mute = el("button", "", actions, p.muted ? "Unmute" : "Mute");
      mute.onclick = () => {
        vc.setMuted(p.id, !p.muted);
        this.renderPeople();
      };
      const confirming = this.blockConfirm === p.id;
      const block = el("button", confirming ? "danger" : "", actions, confirming ? "Confirm block" : "Block");
      block.title = "Neither of you will hear the other again";
      block.onclick = () => {
        if (confirming) {
          vc.block(p.id);
          this.blockConfirm = null;
        } else this.blockConfirm = p.id;
        this.renderPeople();
      };
    }
    const report = el("button", "", actions, "Report");
    report.onclick = () => {
      this.reportFor = p.id;
      this.reportReason = VOICE_REPORT_REASONS[0];
      list.innerHTML = "";
      for (const q of vc.peers().slice(0, 40)) this.renderPerson(list, q, admin);
    };
    if (admin) {
      const m = el("button", "admin", actions, p.adminMuted ? "Unmute (mod)" : "Voice-mute (mod)");
      m.onclick = () => vc.adminMute(p.id, !p.adminMuted);
    }
  }
}

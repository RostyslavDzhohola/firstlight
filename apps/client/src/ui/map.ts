// Map (M): a top-down map of the current body, seen from above. The ground (terrain colours, water,
// relief, and the Portus town plan) comes from the map atlas worker (ui/mapAtlas.ts); on top go the
// named places, peaks and lakes, pads (discovered or not), portals, the mission guide, boss lairs,
// mission targets, your party, your waypoint and you. Drag to pan, wheel or +/- to zoom, north-up
// or your-heading-up (ui/mapView.ts: the compass's north, so the map and the compass agree).
// Click to drop a waypoint (F over a point too); right-click clears it. Clicking a discovered pad
// while standing on a pad fast-travels, as before.

import { BODIES, safePadAt, type BodyId } from "@firstlight/shared";
import type { Game } from "../game/Game.ts";
import { headingOf, surfaceDistance, type V3 } from "../social/compassMath.ts";
import { partyState } from "../social/store.ts";
import { PARTY_COLOURS } from "../social/compass.ts";
import { Panel } from "./panels.ts";
import { el } from "./dom.ts";
import { layoutMapLabels, type MapLabel } from "./mapLabels.ts";
import { mapAtlas, type ViewImage } from "./mapAtlas.ts";
import { atlasResolution } from "./mapRaster.ts";
import { missionTargets, staticMarkers, type MapMarker } from "./mapMarkers.ts";
import { mapView, metresPerPixel, placeUnder, project, screenAngle, unproject, zoomView, type MapView, type Projected } from "./mapView.ts";
import { arrow, diamond, star } from "./minimap.ts";
import { uiSettings } from "./uiSettings.ts";
import { WAYPOINT_COLOUR, waypoints } from "./waypoint.ts";

const DEG = Math.PI / 180;
/** Closest zoom: ground metres per screen pixel (a quarter atlas texel; the Portus town plan is finer). */
const MIN_MPP = 0.12;
const minMpp = (body: BodyId) => (body === "portus" ? MIN_MPP : Math.max(MIN_MPP, (BODIES[body].radius * Math.PI) / 2 / atlasResolution(BODIES[body].radius) / 4));
/** Ground radius (m) shown when the map opens: the walled town on Portus, the surroundings elsewhere. */
const OPEN_RANGE = { portus: 80, planet: 220 };

const unit = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

interface Hit {
  marker?: MapMarker;
  label: string;
  dir: V3;
}

export class MapPanel extends Panel {
  protected closeKeys = ["KeyM"];
  private readonly view = el("div", "fl-map__view");
  private readonly canvas = el("canvas", "", this.view) as HTMLCanvasElement;
  private readonly wpEl = el("div", "fl-map__wp", this.view);
  private readonly tip = el("div", "tip");
  private readonly turnBtn = el("button", "fl-btn fl-btn--sm fl-btn--ghost") as HTMLButtonElement;
  private readonly clearBtn = el("button", "fl-btn fl-btn--sm fl-btn--ghost") as HTMLButtonElement;
  private markers: MapMarker[] | null = null;
  private v: MapView | null = null;
  private w = 900;
  private h = 600;
  private dpr = 1;
  private img: ViewImage | null = null;
  private version = 0;
  private requested = { version: -1, scale: 0 };
  private changedAt = 0;
  private drawnAt = 0;
  private dirty = true;
  private drag: { x: number; y: number; start: MapView; grabbed: V3 | null; moved: boolean } | null = null;
  private hover: { x: number; y: number } | null = null;
  private raf = 0;
  private wpPos = "";
  private buttons = "";
  private stickyUntil = 0;
  private tipText = "";
  private readonly zoomByBody = new Map<string, number>();
  private readonly p: Projected = { x: 0, y: 0, z: 0 };

  private readonly onUp = (e: MouseEvent) => {
    if (!this.drag || e.button !== 0) return;
    const d = this.drag;
    this.drag = null;
    this.canvas.classList.remove("drag");
    if (!d.moved) this.click(e);
  };
  private readonly onMove = (e: MouseEvent) => {
    if (!this.isOpen) return;
    const { x, y } = this.local(e);
    if (this.drag) {
      if (Math.abs(e.clientX - this.drag.x) + Math.abs(e.clientY - this.drag.y) > 3) this.drag.moved = true;
      if (this.drag.moved && this.drag.grabbed) this.setView(placeUnder(this.drag.start, this.drag.grabbed, x, y));
      return;
    }
    this.hover = x >= 0 && y >= 0 && x <= this.w && y <= this.h ? { x, y } : null;
    this.dirty = true;
  };
  private readonly onKeys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === "Equal" || e.code === "NumpadAdd") this.zoom(1.5);
    else if (e.code === "Minus" || e.code === "NumpadSubtract") this.zoom(1 / 1.5);
    else if (e.code === "KeyF" && this.hover) this.dropAt(this.hover.x, this.hover.y);
    else if (e.code === "KeyC") this.centre();
    else return;
    e.preventDefault();
  };

  constructor(game: Game) {
    super(game, "fl-q fl-map");
    this.box.dataset.e2e = "world-map";
    this.wpEl.dataset.e2e = "map-waypoint";
    this.wpEl.hidden = true;
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.v) return;
      const { x, y } = this.local(e);
      this.drag = { x: e.clientX, y: e.clientY, start: this.v, grabbed: unproject(this.v, x, y), moved: false };
      this.canvas.classList.add("drag");
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x, y } = this.local(e);
      this.zoom(Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.0022), x, y);
    }, { passive: false });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (waypoints.get(this.game.bodyId)) {
        waypoints.clear(this.game.bodyId);
        this.say("Waypoint cleared");
        this.dirty = true;
      }
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.dirty = true;
    });
  }

  open() {
    super.open();
    const body = this.game.bodyId;
    const R = BODIES[body].radius;
    this.markers ??= staticMarkers(body, this.game.planet.terrain);
    const p = this.game.player.pos;
    const range = body === "portus" ? OPEN_RANGE.portus : OPEN_RANGE.planet;
    const ppr = this.zoomByBody.get(body) ?? (R * Math.min(this.w, this.h)) / 2 / range;
    this.v = mapView(unit(p.x, p.y, p.z), uiSettings.get().mapPlayerUp ? this.heading() : 0, this.clampPpr(ppr), this.w, this.h);
    this.changed();
    window.addEventListener("mouseup", this.onUp);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("keydown", this.onKeys);
    const loop = () => {
      if (!this.isOpen) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(relock = true) {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mouseup", this.onUp);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("keydown", this.onKeys);
    this.drag = null;
    this.hover = null;
    if (this.v) this.zoomByBody.set(this.game.bodyId, this.v.ppr);
    super.close(relock);
  }

  render() {
    const b = this.box;
    b.innerHTML = "";
    const def = BODIES[this.game.bodyId];
    const head = el("div", "fl-map__head", b);
    el("h2", "", head, def.name.toUpperCase());
    const tools = el("div", "fl-map__tools", head);
    const btn = (text: string, title: string, fn: () => void, e = el("button", "fl-btn fl-btn--sm fl-btn--ghost") as HTMLButtonElement) => {
      e.type = "button";
      e.textContent = text;
      e.title = title;
      e.onclick = () => {
        fn();
        e.blur();
      };
      tools.appendChild(e);
      return e;
    };
    btn("−", "Zoom out (−)", () => this.zoom(1 / 1.5));
    btn("+", "Zoom in (+)", () => this.zoom(1.5));
    btn("Centre on me", "Centre on you (C)", () => this.centre());
    btn("", "Turn the map", () => this.toggleTurn(), this.turnBtn);
    btn("Clear waypoint", "Clear the waypoint (right-click the map)", () => {
      waypoints.clear(this.game.bodyId);
      this.say("Waypoint cleared");
      this.dirty = true;
    }, this.clearBtn);
    this.syncButtons();

    this.w = Math.max(320, Math.min(1040, Math.floor(window.innerWidth * 0.9) - 40));
    this.h = Math.max(260, Math.min(700, Math.floor(window.innerHeight * 0.86) - 170));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.view.style.width = `${this.w}px`;
    this.view.style.height = `${this.h}px`;
    b.appendChild(this.view);
    this.tip.className = "tip";
    b.appendChild(this.tip);
    this.buttons = "";
    const legend = el("div", "legend", b);
    legend.innerHTML =
      def.padLayout === "none"
        ? "<span><i class=\"k portal\"></i>portal to a planet</span><span><i class=\"k shop\"></i>shop</span><span><i class=\"k wp\"></i>waypoint</span><span>click: set a waypoint · right-click: clear · drag: pan · wheel: zoom · M: close</span>"
        : "<span><i class=\"k pad on\"></i>discovered pad</span><span><i class=\"k pad\"></i>undiscovered</span><span><i class=\"k guide\"></i>mission guide</span><span><i class=\"k lair\"></i>boss lair</span><span>★ mission</span><span><i class=\"k wp\"></i>waypoint</span><span>click: waypoint · right-click: clear · click a pad while on one: travel · drag · wheel · M</span>";
    if (this.v) {
      this.v = mapView(this.v.c, this.v.rot, this.v.ppr, this.w, this.h);
      this.changed();
    }
  }

  // ------------------------------------------------------------------------------------------ view

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private heading(): number {
    const p = this.game.player.pos, f = this.game.player.camForward;
    return headingOf([p.x, p.y, p.z], [f.x, f.y, f.z]);
  }

  private clampPpr(ppr: number): number {
    const R = BODIES[this.game.bodyId].radius;
    const fit = 0.46 * Math.min(this.w, this.h);
    return Math.max(fit, Math.min(R / minMpp(this.game.bodyId), ppr));
  }

  private setView(v: MapView) {
    this.v = v;
    this.changed();
  }

  private changed() {
    this.version++;
    this.changedAt = performance.now();
    this.dirty = true;
  }

  private zoom(k: number, x = this.w / 2, y = this.h / 2) {
    if (!this.v) return;
    const ppr = this.clampPpr(this.v.ppr * k);
    if (Math.abs(ppr - this.v.ppr) < 1e-9) return;
    this.setView(zoomView(this.v, ppr / this.v.ppr, x, y));
  }

  private centre() {
    if (!this.v) return;
    const p = this.game.player.pos;
    this.setView(mapView(unit(p.x, p.y, p.z), this.v.rot, this.v.ppr, this.w, this.h));
  }

  private toggleTurn() {
    if (!this.v) return;
    const up = !uiSettings.get().mapPlayerUp;
    uiSettings.set({ mapPlayerUp: up });
    this.setView(mapView(this.v.c, up ? this.heading() : 0, this.v.ppr, this.w, this.h));
    this.syncButtons();
  }

  private syncButtons() {
    const up = uiSettings.get().mapPlayerUp;
    const has = !!waypoints.get(this.game.bodyId);
    const key = `${up}|${has}|${this.turnBtn.isConnected}`;
    if (key === this.buttons) return;
    this.buttons = key;
    this.turnBtn.textContent = up ? "Heading up" : "North up";
    this.turnBtn.title = up ? "The map turns with your heading. Click for north up." : "North is up. Click to turn the map to your heading.";
    this.clearBtn.disabled = !has;
  }

  // ------------------------------------------------------------------------------------------ frame

  private frame() {
    const now = performance.now();
    const v = this.v;
    if (!v) return;
    // Terrain: half resolution while the view moves, full once it settles.
    const moving = now - this.changedAt < 180 || !!this.drag?.moved;
    const scale = moving ? 0.5 : 1;
    if (this.requested.version !== this.version || this.requested.scale < scale) {
      this.requested = { version: this.version, scale };
      const req = { c: v.c, rot: v.rot, ppr: v.ppr * scale, w: Math.round(this.w * scale), h: Math.round(this.h * scale), limb: v.ppr < 0.8 * Math.min(this.w, this.h) };
      mapAtlas.render("map", this.game.bodyId, req, (img) => {
        if (!img) return;
        const old = this.img;
        this.img = img;
        if (old && typeof ImageBitmap !== "undefined" && old.image instanceof ImageBitmap) old.image.close();
        this.dirty = true;
        if (img.baked < 6) this.requested.version = -1; // ask again as more faces bake
      });
    }
    if (this.dirty || now - this.drawnAt > 120) {
      this.dirty = false;
      this.drawnAt = now;
      this.draw(v);
    }
  }

  private draw(v: MapView) {
    const ctx = this.canvas.getContext("2d")!;
    const W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const body = this.game.bodyId;
    const def = BODIES[body];
    const R = def.radius;
    this.drawGround(ctx, v);

    // Globe rim when the whole body fits.
    if (v.ppr < Math.hypot(W, H) / 2) {
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, v.ppr, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(159, 216, 255, .45)";
      ctx.stroke();
    }

    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    const labels: (MapLabel & { text: string; color: string })[] = [];
    const marks: { x: number; y: number; radius: number }[] = [];
    const label = (id: string, text: string, s: { x: number; y: number }, color: string, priority: number, radius = 6) => {
      labels.push({ id, text, x: s.x, y: s.y, color, priority, width: ctx.measureText(text).width + 10 });
      marks.push({ x: s.x, y: s.y, radius });
    };
    const visible = (s: Projected, pad = 10) => s.z > 0.05 && s.x > -pad && s.y > -pad && s.x < W + pad && s.y < H + pad;
    const mpp = metresPerPixel(v, R);
    const you = this.game.hud.you;
    const known = new Set(you?.pads ?? []);
    const pos = this.game.player.pos;
    const here = def.padLayout === "none" ? -1 : safePadAt(def, pos.x, pos.y, pos.z);

    // Hunt-area rings when they're big enough to read (on the globe, and not where it's foreshortened).
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, v.ppr, 0, Math.PI * 2);
    ctx.clip();
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, .28)";
    for (const m of this.markers ?? []) {
      if (!m.area) continue;
      const r = m.area / mpp;
      if (r < 24 || r > 900) continue;
      const s = project(v, m.dir, this.p);
      if (s.z <= 0.8) continue;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    for (const m of this.markers ?? []) {
      const s = project(v, m.dir, { x: 0, y: 0, z: 0 });
      if (!visible(s)) continue;
      switch (m.kind) {
        case "place":
        case "town":
          ctx.fillStyle = "rgba(255,255,255,.85)";
          ctx.beginPath();
          ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          label(m.id, m.label, s, "#f4f1ea", 1);
          break;
        case "peak":
          triangle(ctx, s.x, s.y, 6, "#e9e2d0");
          label(m.id, `${m.label}`, s, "#f4f1ea", 1);
          break;
        case "lake":
          label(m.id, m.label, s, "#bfefff", 1, 2);
          break;
        case "lair":
          diamond(ctx, s.x, s.y, 8, "#ff5a6a");
          label(m.id, m.label, s, "#ffd0d4", 2, 10);
          break;
        case "guide":
          ctx.beginPath();
          ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = "#ffd166";
          ctx.strokeStyle = "#0b1016";
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#0b1016";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("!", s.x, s.y + 0.5);
          label(m.id, m.label, s, "#ffe2a0", 2, 9);
          break;
        case "shop":
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffd166";
          ctx.strokeStyle = "#0b1016";
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
          label(m.id, m.label, s, "#ffe2a0", 2);
          break;
        case "portal":
          ctx.beginPath();
          ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#36f9f6";
          ctx.stroke();
          label(m.id, m.label, s, "#9ffcfa", 3, 8);
          break;
        case "pad": {
          const got = known.has(m.pad!);
          ctx.lineWidth = 2;
          ctx.strokeStyle = got ? "#0b1016" : "#c9c2e0";
          ctx.fillStyle = m.pad === 0 ? "#ffd8a8" : got ? "#36f9f6" : "rgba(0,0,0,.45)";
          ctx.beginPath();
          ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if (m.pad === here) {
            ctx.strokeStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
            ctx.stroke();
          }
          label(m.id, got || m.pad === 0 ? m.label : `${m.label} (undiscovered)`, s, got ? "#72f1b8" : "#c9c2e0", got || m.pad === 0 ? 3 : 1, 12);
          break;
        }
      }
    }

    // Active mission targets.
    for (const t of missionTargets(body, you?.missions ?? [])) {
      const s = project(v, t.dir, { x: 0, y: 0, z: 0 });
      if (!visible(s)) continue;
      star(ctx, s.x, s.y - 14, 8, "#ffd166");
      label(`mission:${t.id}`, `★ ${t.label}`, { x: s.x, y: s.y - 14 }, "#ffe2a0", 2, 9);
    }

    // Party members.
    const room = this.game.net.room;
    const players = (room?.state as { players?: Map<string, { x: number; y: number; z: number; userId: string }> } | undefined)?.players;
    if (room && players) {
      const myId = players.get(room.sessionId)?.userId;
      partyState().members.forEach((m, i) => {
        if (m.userId === myId || !m.online || m.body !== body) return;
        const here2 = m.roomId === room.roomId && m.sessionId ? players.get(m.sessionId) : null;
        const at = here2 ?? (m.x || m.y || m.z ? m : null);
        if (!at) return;
        const s = project(v, unit(at.x, at.y, at.z), { x: 0, y: 0, z: 0 });
        if (!visible(s)) return;
        const col = PARTY_COLOURS[i % PARTY_COLOURS.length]!;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.strokeStyle = "#0b1016";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        label(`party:${m.userId}`, m.name, s, col, 2);
      });
    }

    // Waypoint.
    const me = unit(pos.x, pos.y, pos.z);
    const wp = waypoints.get(body);
    let wpScreen: Projected | null = null;
    if (wp) {
      const s = project(v, wp, { x: 0, y: 0, z: 0 });
      if (visible(s, 0)) {
        wpScreen = s;
        diamond(ctx, s.x, s.y, 9, WAYPOINT_COLOUR);
        label("waypoint", `Waypoint · ${fmtDist(surfaceDistance(me, wp, R))}`, s, WAYPOINT_COLOUR, 4, 11);
      }
    }
    this.placeWaypointEl(wpScreen);

    // You.
    const sMe = project(v, me, { x: 0, y: 0, z: 0 });
    if (sMe.z > 0) marks.push({ x: sMe.x, y: sMe.y, radius: 13 });

    // Labels: leaders first, then text on dark chips.
    const byId = new Map(labels.map((l) => [l.id, l]));
    const placed = layoutMapLabels(labels, W, H, marks);
    ctx.lineWidth = 1;
    for (const l of placed) {
      ctx.strokeStyle = byId.get(l.id)!.color;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(Math.max(l.left, Math.min(l.left + l.width, l.x)), Math.max(l.top, Math.min(l.top + l.height, l.y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const l of placed) {
      const src = byId.get(l.id)!;
      ctx.fillStyle = "rgba(5, 10, 15, .78)";
      ctx.fillRect(l.left, l.top, l.width, l.height);
      ctx.fillStyle = src.color;
      ctx.fillText(src.text, l.left + l.width / 2, l.top + l.height / 2 + 0.5);
    }

    if (sMe.z > 0) {
      const f = this.game.player.facing;
      arrow(ctx, sMe.x, sMe.y, screenAngle(v, [f.x, f.y, f.z]), 11);
    }
    this.drawNorth(ctx, v);
    this.drawScale(ctx, mpp);
    this.drawHover(ctx, v, me, R);
    this.syncButtons();
  }

  /** The ground image, carried from the view it was drawn for to this one. */
  private drawGround(ctx: CanvasRenderingContext2D, v: MapView) {
    const img = this.img;
    if (!img || img.body !== this.game.bodyId) {
      ctx.fillStyle = "#11161c";
      ctx.beginPath();
      ctx.arc(this.w / 2, this.h / 2, Math.min(v.ppr, Math.hypot(this.w, this.h)), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#c4f1ff";
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Charting the ground…", this.w / 2, this.h / 2);
      return;
    }
    const q = img.req;
    const c = project(v, q.c, { x: 0, y: 0, z: 0 });
    const iv = mapView(q.c, q.rot, q.ppr, q.w, q.h);
    const step = 0.002;
    const up = project(v, unit(q.c[0] + iv.n[0] * step, q.c[1] + iv.n[1] * step, q.c[2] + iv.n[2] * step), { x: 0, y: 0, z: 0 });
    const ang = Math.atan2(up.x - c.x, -(up.y - c.y));
    const k = v.ppr / q.ppr;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(ang);
    ctx.scale(k, k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img.image, -q.w / 2, -q.h / 2, q.w, q.h);
    ctx.restore();
  }

  private drawNorth(ctx: CanvasRenderingContext2D, v: MapView) {
    const x = this.w - 34, y = 40;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, 19, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(5, 10, 15, .7)";
    ctx.fill();
    ctx.rotate(-v.rot * DEG);
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(5, 0);
    ctx.lineTo(-5, 0);
    ctx.closePath();
    ctx.fillStyle = "#ffcf7a";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.lineTo(5, 0);
    ctx.lineTo(-5, 0);
    ctx.closePath();
    ctx.fillStyle = "rgba(196, 241, 255, .55)";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#ffcf7a";
    ctx.font = "700 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const a = -v.rot * DEG;
    ctx.fillText("N", x + Math.sin(a) * 28, y - Math.cos(a) * 28);
  }

  private drawScale(ctx: CanvasRenderingContext2D, mpp: number) {
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
    let m = nice[0]!;
    for (const n of nice) if (n / mpp <= 140) m = n;
    const px = m / mpp;
    const x = 16, y = this.h - 18;
    ctx.fillStyle = "rgba(5, 10, 15, .7)";
    ctx.fillRect(x - 8, y - 18, px + 16, 28);
    ctx.strokeStyle = "#f4f1ea";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = "#f4f1ea";
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fmtDist(m), x + px / 2, y - 6);
  }

  private setTip(text: string) {
    if (text === this.tipText) return;
    this.tipText = text;
    this.tip.textContent = text;
  }

  private drawHover(ctx: CanvasRenderingContext2D, v: MapView, me: V3, R: number) {
    const h = this.hover;
    const sticky = performance.now() < this.stickyUntil;
    if (!h || this.drag?.moved) {
      if (!sticky) this.setTip("");
      return;
    }
    const hit = this.hitAt(h.x, h.y);
    const d = hit?.dir ?? unproject(v, h.x, h.y);
    if (!d) return;
    const dist = fmtDist(surfaceDistance(me, d, R));
    if (!hit) {
      ctx.strokeStyle = "rgba(255, 95, 210, .8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(h.x - 7, h.y);
      ctx.lineTo(h.x + 7, h.y);
      ctx.moveTo(h.x, h.y - 7);
      ctx.lineTo(h.x, h.y + 7);
      ctx.stroke();
    }
    if (sticky) return;
    const m = hit?.marker;
    if (m?.kind === "pad") {
      const got = this.game.hud.you?.pads.includes(m.pad!);
      this.setTip(`${m.label} · ${dist} · ${got ? "discovered: stand on a pad and click to travel" : "undiscovered: touch it once to unlock"}`);
    } else this.setTip(hit ? `${hit.label} · ${dist} · click to set a waypoint` : `${dist} from you · click to set a waypoint`);
  }

  /** The DOM marker over the waypoint (what a player sees, for tests and screen readers). */
  private placeWaypointEl(s: Projected | null) {
    const key = s ? `${s.x.toFixed(1)},${s.y.toFixed(1)}` : "";
    if (key === this.wpPos) return;
    this.wpPos = key;
    this.wpEl.hidden = !s;
    if (s) this.wpEl.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
  }

  // ------------------------------------------------------------------------------------------ clicks

  private hitAt(x: number, y: number): Hit | null {
    const v = this.v;
    if (!v) return null;
    let best: Hit | null = null, bestD = 13;
    for (const m of this.markers ?? []) {
      const s = project(v, m.dir, this.p);
      if (s.z <= 0) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = { marker: m, label: m.label, dir: m.dir };
      }
    }
    return best;
  }

  private say(text: string) {
    this.setTip(text);
    this.stickyUntil = performance.now() + 2600;
  }

  private click(ev: MouseEvent) {
    const { x, y } = this.local(ev);
    const hit = this.hitAt(x, y);
    const m = hit?.marker;
    if (m?.kind === "pad") {
      const def = BODIES[this.game.bodyId];
      const p = this.game.player.pos;
      const here = safePadAt(def, p.x, p.y, p.z);
      const got = this.game.hud.you?.pads.includes(m.pad!);
      if (got && here >= 0 && here !== m.pad) {
        this.game.net.room?.send("fastTravel", { pad: m.pad });
        this.close();
        return;
      }
      this.setWaypoint(m.dir, got ? (here === m.pad ? "You're already here" : "Stand on a pad (inside its safe ring) to fast travel; waypoint set") : "Undiscovered: walk onto it once to unlock it; waypoint set");
      return;
    }
    this.dropAt(x, y, hit?.dir);
  }

  private dropAt(x: number, y: number, dir?: V3) {
    const v = this.v;
    const d = dir ?? (v ? unproject(v, x, y) : null);
    if (!d) return;
    this.setWaypoint(d);
  }

  private setWaypoint(d: V3, note?: string) {
    const body = this.game.bodyId;
    waypoints.set(body, d);
    const p = this.game.player.pos;
    const dist = fmtDist(surfaceDistance(unit(p.x, p.y, p.z), d, BODIES[body].radius));
    this.say(note ?? `Waypoint set · ${dist} · follow the pink pillar and the compass · right-click to clear`);
    this.dirty = true;
  }
}

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.9, y + r * 0.6);
  ctx.lineTo(x - r * 0.9, y + r * 0.6);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.strokeStyle = "#0b1016";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
}

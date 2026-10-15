// HUD minimap (top right, above the mission tracker): one canvas drawn each frame. The ground is a
// north-up tile the map atlas worker renders around you (re-requested after you've walked a quarter
// of it), drawn with one transformed drawImage; on top go pads, portals, the mission guide, mission
// targets, nearby NPCs (hostile red, wildlife neutral), party members, your waypoint (pinned to the
// rim when far) and your arrow. It turns with the camera or stays north-up (settings). Its size
// comes from minimapLayout.ts, checked twice a second against the tutorial panel, the player card,
// the hotbar and the save card: no layout reads in the frame.

import { BODIES, padDirs } from "@firstlight/shared";
import { NF, NPC_DEFS } from "@firstlight/shared/content/npcs";
import type { Game } from "../game/Game.ts";
import { headingOf, surfaceDistance, type V3 } from "../social/compassMath.ts";
import { PARTY_COLOURS } from "../social/compass.ts";
import { partyState } from "../social/store.ts";
import { el } from "./dom.ts";
import { mapAtlas, type ViewImage } from "./mapAtlas.ts";
import { missionTargets, staticMarkers, type MapMarker } from "./mapMarkers.ts";
import { mapView, project, type MapView, type Projected } from "./mapView.ts";
import { minimapRange, minimapSize, preferredMinimapSize } from "./minimapLayout.ts";
import { uiSettings } from "./uiSettings.ts";
import { WAYPOINT_COLOUR, waypoints } from "./waypoint.ts";

const MIN_SIZE = 110;
const TILE_PX = 384;
/** The tile covers this much more than the minimap's radius, so it can scroll before a refresh. */
const TILE_OVER = 1.5;
const HOSTILE = "#ff4f5e";
const WILD = "#f2e6c8";
const DEG = Math.PI / 180;

const unit = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

export class Minimap {
  readonly root = el("div", "fl-minimap");
  private readonly canvas = el("canvas", "", this.root) as HTMLCanvasElement;
  private readonly ctx = this.canvas.getContext("2d")!;
  private readonly markers: MapMarker[];
  private readonly radius: number;
  private size = 0;
  private dpr = 1;
  private tile: ViewImage | null = null;
  private wantTile = true;
  private layoutAt = 0;
  private targetsFor: unknown = null;
  private targets: { dir: V3 }[] = [];
  private readonly p: Projected = { x: 0, y: 0, z: 0 };
  private readonly offs: (() => void)[] = [];
  /** Draw cost (ms): exponential average and worst since the last read. */
  readonly stats = { avgMs: 0, maxMs: 0, frames: 0 };

  constructor(private readonly game: Game, slot: HTMLElement) {
    this.root.dataset.e2e = "minimap";
    this.root.setAttribute("aria-hidden", "true");
    slot.appendChild(this.root);
    this.radius = BODIES[game.bodyId].radius;
    this.markers = staticMarkers(game.bodyId, game.planet.terrain).filter((m) => m.kind === "pad" || m.kind === "portal" || m.kind === "guide" || m.kind === "lair" || m.kind === "shop");
    this.offs.push(mapAtlas.onFace((body) => {
      if (body === this.game.bodyId) this.wantTile = true;
    }));
    this.offs.push(uiSettings.onChange(() => this.layout(true)));
    this.layout(true);
  }

  /** Re-check the size against the HUD (twice a second, or now). */
  private layout(force = false) {
    const now = performance.now();
    if (!force && now - this.layoutAt < 500) return;
    this.layoutAt = now;
    const on = uiSettings.get().minimap;
    let size = 0;
    if (on) {
      const col = this.root.parentElement?.parentElement?.getBoundingClientRect();
      const rect = (sel: string) => {
        const e = document.querySelector(sel);
        if (!e || (e as HTMLElement).hidden) return null;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
      };
      const avoid = [rect(".fl-onb__widget"), rect(".fl-me"), rect(".fl-hotbar-wrap"), rect(".fl-savecard, [data-e2e=\"save-card\"]")];
      size = col ? minimapSize({ right: col.right, top: col.top }, preferredMinimapSize(innerWidth), MIN_SIZE, avoid, innerWidth, innerHeight) : 0;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (size === this.size && dpr === this.dpr) return;
    this.size = size;
    this.dpr = dpr;
    this.root.hidden = size === 0;
    if (!size) return;
    this.root.style.width = this.root.style.height = `${size}px`;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.wantTile = true;
  }

  update() {
    this.layout();
    if (!this.size || this.game.photo?.active) return;
    const t0 = performance.now();
    this.draw();
    const ms = performance.now() - t0;
    const s = this.stats;
    s.avgMs = s.frames ? s.avgMs * 0.95 + ms * 0.05 : ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.frames++;
  }

  private draw() {
    const g = this.game;
    const body = g.bodyId;
    const R = this.radius;
    const S = this.size;
    const half = S / 2;
    const rim = half - 3;
    const range = minimapRange(body);
    const pos = g.player.pos;
    const me = unit(pos.x, pos.y, pos.z);
    const f = g.player.camForward;
    const heading = headingOf([pos.x, pos.y, pos.z], [f.x, f.y, f.z]);
    const rotate = uiSettings.get().minimapRotate;
    const v = mapView(me, rotate ? heading : 0, (rim / range) * R, S, S);
    this.maybeRequestTile(me, range);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, rim, 0, Math.PI * 2);
    ctx.fillStyle = "#14181d";
    ctx.fill();
    ctx.clip();
    const tile = this.tile;
    if (tile && tile.body === body) this.drawTile(v, tile, R);

    // Static markers in range.
    for (const m of this.markers) {
      const s = project(v, m.dir, this.p);
      if (s.z <= 0 || Math.hypot(s.x - half, s.y - half) > rim + 6) continue;
      this.marker(m, s.x, s.y);
    }
    // Active mission targets (recomputed when the `you` state changes).
    if (g.hud.you !== this.targetsFor) {
      this.targetsFor = g.hud.you;
      this.targets = missionTargets(body, g.hud.you?.missions ?? []);
    }
    for (const t of this.targets) {
      const s = project(v, t.dir, this.p);
      if (Math.hypot(s.x - half, s.y - half) <= rim) star(ctx, s.x, s.y, 5, "#ffd166");
    }
    this.drawNpcs(v, half, rim);
    this.drawParty(v, half, rim);
    ctx.restore();

    // Waypoint: on the map, or pinned to the rim pointing at it.
    const wp = waypoints.get(body);
    if (wp) {
      const s = project(v, wp, this.p);
      const dx = s.x - half, dy = s.y - half;
      const d = Math.hypot(dx, dy);
      const far = d > rim - 5 || s.z <= 0 || surfaceDistance(me, wp, 1) * R > range * 1.05;
      const k = far ? (rim - 5) / (d || 1) : 1;
      diamond(ctx, half + dx * k, half + dy * k, far ? 4.5 : 5.5, WAYPOINT_COLOUR);
    }

    // You: an arrow along your facing, relative to the view's up.
    const fc = g.player.facing;
    const facing = headingOf([pos.x, pos.y, pos.z], [fc.x, fc.y, fc.z]);
    arrow(ctx, half, half, (facing - v.rot) * DEG, 7);

    // Rim and north.
    ctx.beginPath();
    ctx.arc(half, half, rim, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(196, 241, 255, .55)";
    ctx.stroke();
    const na = -v.rot * DEG;
    const nx = half + Math.sin(na) * (rim - 1), ny = half - Math.cos(na) * (rim - 1);
    ctx.beginPath();
    ctx.arc(nx, ny, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1016";
    ctx.fill();
    ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffcf7a";
    ctx.fillText("N", nx, ny + 0.5);
  }

  /** Draw the north-up tile under the current view: one translate-rotate-scale drawImage. */
  private drawTile(v: MapView, tile: ViewImage, R: number) {
    const tv = tile.req;
    const c = project(v, tv.c, this.p);
    const cx = c.x, cy = c.y;
    // The tile's north (at its centre) on this view: north = up on the tile.
    const tileView = mapView(tv.c, 0, tv.ppr, tv.w, tv.h);
    const step = 4 / R;
    const nd: V3 = unit(tv.c[0] + tileView.n[0] * step, tv.c[1] + tileView.n[1] * step, tv.c[2] + tileView.n[2] * step);
    const n = project(v, nd, this.p);
    const ang = Math.atan2(n.x - cx, -(n.y - cy));
    const k = v.ppr / tv.ppr;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.scale(k, k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tile.image, -tv.w / 2, -tv.h / 2, tv.w, tv.h);
    ctx.restore();
  }

  private maybeRequestTile(me: V3, range: number) {
    const tile = this.tile;
    const ppr = TILE_PX / (2 * TILE_OVER * range) * this.radius;
    const stale = !tile || tile.body !== this.game.bodyId || Math.abs(tile.req.ppr - ppr) > 1e-6 * ppr ||
      surfaceDistance(me, tile.req.c, 1) * this.radius > range * TILE_OVER * 0.25;
    if (!stale && !this.wantTile) return;
    this.wantTile = false;
    mapAtlas.render("minimap", this.game.bodyId, { c: me, rot: 0, ppr, w: TILE_PX, h: TILE_PX }, (img) => {
      if (!img) {
        this.wantTile = true;
        return;
      }
      const old = this.tile;
      this.tile = img;
      if (old && old.image !== img.image && typeof ImageBitmap !== "undefined" && old.image instanceof ImageBitmap) old.image.close();
      // A tile drawn before every face was baked is replaced once the bake finishes.
      if (img.baked < 6) this.wantTile = mapAtlas.baked > img.baked;
    });
  }

  private marker(m: MapMarker, x: number, y: number) {
    const ctx = this.ctx;
    const known = m.kind === "pad" ? (this.game.hud.you?.pads ?? []).includes(m.pad!) : true;
    ctx.lineWidth = 1.5;
    switch (m.kind) {
      case "pad":
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = known ? "#36f9f6" : "#0009";
        ctx.strokeStyle = known ? "#0b1016" : "#c9c2e0";
        ctx.fill();
        ctx.stroke();
        break;
      case "portal":
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#36f9f6";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        break;
      case "guide":
      case "shop":
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd166";
        ctx.strokeStyle = "#0b1016";
        ctx.fill();
        ctx.stroke();
        break;
      case "lair":
        diamond(this.ctx, x, y, 5, "#ff5a6a");
        break;
    }
  }

  private drawNpcs(v: MapView, half: number, rim: number) {
    const state = this.game.net.room?.state as { npcs?: Map<string, { x: number; y: number; z: number; kind: number; flags: number }> } | undefined;
    if (!state?.npcs) return;
    const ctx = this.ctx;
    const hostile = new Path2D(), wild = new Path2D(), boss = new Path2D();
    let any = false;
    state.npcs.forEach((n) => {
      if (n.flags & NF.DEAD) return;
      const def = NPC_DEFS[n.kind];
      if (!def) return;
      const s = project(v, unit(n.x, n.y, n.z), this.p);
      if (s.z <= 0 || Math.hypot(s.x - half, s.y - half) > rim) return;
      any = true;
      if (def.family === "boss") {
        boss.moveTo(s.x + 5, s.y);
        boss.arc(s.x, s.y, 5, 0, Math.PI * 2);
      } else if (def.temper === "hostile" || n.flags & (NF.AGGRO | NF.ENGAGED)) {
        hostile.moveTo(s.x + 3, s.y);
        hostile.arc(s.x, s.y, 3, 0, Math.PI * 2);
      } else {
        wild.moveTo(s.x + 2.5, s.y);
        wild.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      }
    });
    if (!any) return;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#0b1016";
    ctx.fillStyle = WILD;
    ctx.fill(wild);
    ctx.stroke(wild);
    ctx.fillStyle = HOSTILE;
    ctx.fill(hostile);
    ctx.stroke(hostile);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#fff";
    ctx.fill(boss);
    ctx.stroke(boss);
  }

  private drawParty(v: MapView, half: number, rim: number) {
    const room = this.game.net.room;
    const players = (room?.state as { players?: Map<string, { x: number; y: number; z: number; userId: string }> } | undefined)?.players;
    if (!room || !players) return;
    const myId = players.get(room.sessionId)?.userId;
    const ctx = this.ctx;
    partyState().members.forEach((m, i) => {
      if (m.userId === myId || !m.online || m.body !== this.game.bodyId) return;
      const here = m.roomId === room.roomId && m.sessionId ? players.get(m.sessionId) : null;
      const at = here ?? (m.x || m.y || m.z ? m : null);
      if (!at) return;
      const s = project(v, unit(at.x, at.y, at.z), this.p);
      let x = s.x, y = s.y;
      const d = Math.hypot(x - half, y - half);
      if (d > rim - 4) {
        x = half + ((x - half) * (rim - 4)) / d;
        y = half + ((y - half) * (rim - 4)) / d;
      }
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = PARTY_COLOURS[i % PARTY_COLOURS.length]!;
      ctx.strokeStyle = "#0b1016";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    });
  }

  dispose() {
    for (const off of this.offs) off();
    const t = this.tile;
    if (t && typeof ImageBitmap !== "undefined" && t.image instanceof ImageBitmap) t.image.close();
    this.tile = null;
    this.root.remove();
  }
}

/** Your arrow: white with a dark edge, pointing `angle` radians clockwise from up. */
export function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, r: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.72, r * 0.8);
  ctx.lineTo(0, r * 0.38);
  ctx.lineTo(-r * 0.72, r * 0.8);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

export function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

export function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0b1016";
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

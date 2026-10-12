// Map (M): an orthographic globe of the current body drawn on a 2D canvas. Terrain is shaded from
// the shared height function; pads (discovered / not), you, your party, boss lairs and active
// mission targets are drawn on top. Drag to turn the globe; click a discovered pad while standing
// on a pad to fast travel.

import { BODIES, padDirs, safePadAt, type BodyId, type Dir } from "@firstlight/shared";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { BOSS_LAIRS, padName, place, placeDir, placesOn, tangentFrame } from "@firstlight/shared/content/places";
import { objectDir, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import type { Game } from "../game/Game.ts";
import { Panel } from "./panels.ts";

type V = [number, number, number];

const PALETTES: Record<BodyId, { low: V; high: V; peak: V; shallow: V; deep: V }> = {
  portus: { low: [201, 178, 138], high: [122, 138, 90], peak: [180, 170, 150], shallow: [60, 120, 150], deep: [30, 70, 100] },
  arcadia: { low: [61, 122, 58], high: [150, 186, 96], peak: [205, 198, 172], shallow: [38, 140, 160], deep: [13, 53, 80] },
  hollowmere: { low: [60, 47, 82], high: [122, 106, 154], peak: [190, 182, 205], shallow: [40, 96, 110], deep: [18, 40, 60] },
  meridian: { low: [138, 59, 38], high: [208, 138, 90], peak: [232, 220, 205], shallow: [60, 140, 150], deep: [25, 70, 90] },
};

const mix = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function rotate(v: V, axis: V, ang: number): V {
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cx = axis[1] * v[2] - axis[2] * v[1], cy = axis[2] * v[0] - axis[0] * v[2], cz = axis[0] * v[1] - axis[1] * v[0];
  return [v[0] * c + cx * s + axis[0] * d * (1 - c), v[1] * c + cy * s + axis[1] * d * (1 - c), v[2] * c + cz * s + axis[2] * d * (1 - c)];
}

const norm = (v: readonly number[]): V => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

export class MapPanel extends Panel {
  protected closeKeys = ["KeyM"];
  private readonly canvas = document.createElement("canvas");
  private readonly tip = document.createElement("div");
  private readonly terrainCanvas = document.createElement("canvas");
  private size = 560;
  /** View basis: c points at the viewer, e is screen-right, n is screen-up. */
  private c: V = [0, 1, 0];
  private e: V = [1, 0, 0];
  private n: V = [0, 0, 1];
  private terrainKey = "";
  private drag: { x: number; y: number } | null = null;
  private moved = false;
  private hoverPad = -1;
  private raf = 0;
  private relief: { res: number; at: number } = { res: 0, at: 0 };

  constructor(game: Game) {
    super(game, "fl-q fl-map");
    this.canvas.addEventListener("mousedown", (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.canvas.classList.add("drag");
    });
    window.addEventListener("mouseup", (e) => {
      if (!this.drag) return;
      this.canvas.classList.remove("drag");
      this.drag = null;
      if (!this.moved) this.click(e);
      this.relief = { res: 0, at: 0 };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isOpen) return;
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.drag = { x: e.clientX, y: e.clientY };
        const k = 1 / (this.size * 0.45);
        this.turn(-dx * k, dy * k);
      } else this.hover(e);
    });
  }

  open() {
    // Centre on the player, north up.
    const p = this.game.player.pos;
    this.c = norm([p.x, p.y, p.z]);
    const f = tangentFrame(this.c);
    this.e = [...f.east] as V;
    this.n = [...f.north] as V;
    this.terrainKey = "";
    super.open();
    const loop = () => {
      if (!this.isOpen) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(relock = true) {
    cancelAnimationFrame(this.raf);
    super.close(relock);
  }

  render() {
    const b = this.box;
    b.innerHTML = "";
    const def = BODIES[this.game.bodyId];
    const h = document.createElement("h2");
    h.textContent = def.name.toUpperCase();
    b.appendChild(h);
    this.size = Math.min(560, Math.floor(window.innerHeight * 0.66));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = this.canvas.style.height = `${this.size}px`;
    b.appendChild(this.canvas);
    this.tip.className = "tip";
    b.appendChild(this.tip);
    const legend = document.createElement("div");
    legend.className = "legend";
    legend.innerHTML =
      def.padLayout === "none"
        ? "<span>Portus has no pads — portals lead to the planets</span><span>drag to turn · M or Esc to close</span>"
        : "<span>◉ discovered pad</span><span>○ undiscovered</span><span>◆ boss lair</span><span>★ mission</span><span>drag to turn · click a pad while standing on one to travel · M to close</span>";
    b.appendChild(legend);
  }

  private turn(yaw: number, pitch: number) {
    // Drag right turns the globe right: rotate the view around screen-up and screen-right.
    this.c = norm(rotate(this.c, this.n, yaw));
    this.e = norm(rotate(this.e, this.n, yaw));
    this.c = norm(rotate(this.c, this.e, pitch));
    this.n = norm(rotate(this.n, this.e, pitch));
  }

  private project(d: readonly number[]): { x: number; y: number; z: number } {
    const r = this.size * 0.45;
    const x = d[0]! * this.e[0] + d[1]! * this.e[1] + d[2]! * this.e[2];
    const y = d[0]! * this.n[0] + d[1]! * this.n[1] + d[2]! * this.n[2];
    const z = d[0]! * this.c[0] + d[1]! * this.c[1] + d[2]! * this.c[2];
    return { x: this.size / 2 + x * r, y: this.size / 2 - y * r, z };
  }

  private shadeTerrain(res: number) {
    const body = this.game.bodyId;
    const def = BODIES[body];
    const terrain = this.game.planet.terrain;
    const pal = PALETTES[body];
    const tc = this.terrainCanvas;
    tc.width = tc.height = res;
    const g = tc.getContext("2d")!;
    const img = g.createImageData(res, res);
    const hs = new Float32Array(res * res).fill(NaN);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = ((i + 0.5) / res) * 2 - 1;
        const y = 1 - ((j + 0.5) / res) * 2;
        const rr = x * x + y * y;
        if (rr > 1) continue;
        const z = Math.sqrt(1 - rr);
        const d: Dir = [this.e[0] * x + this.n[0] * y + this.c[0] * z, this.e[1] * x + this.n[1] * y + this.c[1] * z, this.e[2] * x + this.n[2] * y + this.c[2] * z];
        hs[j * res + i] = terrain.rawHeight(d[0], d[1], d[2]);
      }
    }
    const wl = def.waterLevel;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const h = hs[k]!;
        if (Number.isNaN(h)) continue;
        const x = ((i + 0.5) / res) * 2 - 1;
        const y = 1 - ((j + 0.5) / res) * 2;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        let col: V;
        if (h < wl) col = mix(pal.shallow, pal.deep, clamp01((wl - h) / 12));
        else if (h < 25) col = mix(pal.low, pal.high, clamp01((h - wl) / 25));
        else col = mix(pal.high, pal.peak, clamp01((h - 25) / 60));
        const left = i > 0 && !Number.isNaN(hs[k - 1]!) ? hs[k - 1]! : h;
        const up = j > 0 && !Number.isNaN(hs[k - res]!) ? hs[k - res]! : h;
        const relief = h < wl ? 1 : 1 + Math.max(-0.35, Math.min(0.35, ((h - left) + (h - up)) * 0.05));
        const light = (0.45 + 0.55 * z) * relief;
        img.data[k * 4] = Math.min(255, col[0] * light);
        img.data[k * 4 + 1] = Math.min(255, col[1] * light);
        img.data[k * 4 + 2] = Math.min(255, col[2] * light);
        img.data[k * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private draw() {
    const ctx = this.canvas.getContext("2d")!;
    const dpr = this.canvas.width / this.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = this.size;
    const R = S * 0.45;
    const key = `${this.c.map((v) => v.toFixed(3))}|${this.n.map((v) => v.toFixed(3))}`;
    const now = performance.now();
    const wantRes = this.drag ? 72 : 150;
    if (key !== this.terrainKey || this.relief.res !== wantRes) {
      if (!this.drag || now - this.relief.at > 90) {
        this.shadeTerrain(wantRes);
        this.terrainKey = key;
        this.relief = { res: wantRes, at: now };
      }
    }
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrainCanvas, S / 2 - R, S / 2 - R, R * 2, R * 2);
    ctx.restore();
    const rim = ctx.createRadialGradient(S / 2, S / 2, R * 0.85, S / 2, S / 2, R * 1.04);
    rim.addColorStop(0, "#ffffff00");
    rim.addColorStop(1, "#9fd8ff55");
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, R * 1.04, 0, Math.PI * 2);
    ctx.fill();

    const body = this.game.bodyId;
    const def = BODIES[body];
    const you = this.game.hud.you;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";

    // Named places (areas and landmarks).
    for (const p of placesOn(body)) {
      if (p.kind === "hidden" || p.kind === "pad") continue;
      const s = this.project(placeDir(p));
      if (s.z < 0.15) continue;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.45 * s.z})`;
      ctx.fillText(p.name, s.x, s.y + 3);
    }

    // Boss lairs.
    for (const lair of Object.values(BOSS_LAIRS)) {
      if (lair.body !== body) continue;
      const s = this.project(placeDir(lair.place));
      if (s.z < 0) continue;
      ctx.fillStyle = "#ff5a6a";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 8);
      ctx.lineTo(s.x + 7, s.y);
      ctx.lineTo(s.x, s.y + 8);
      ctx.lineTo(s.x - 7, s.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffd0d4";
      ctx.fillText(lair.name, s.x, s.y + 20);
    }

    // Active mission targets on this body.
    for (const m of you?.missions ?? []) {
      if (m.done) continue;
      const md = MISSION_BY_ID.get(m.id);
      if (!md || md.body !== body) continue;
      const dir = md.reach ? placeDir(md.reach.place) : md.find ? objectDir(WORLD_OBJECT_BY_ID.get(md.find.object)!) : md.hunt?.place ? placeDir(place(md.hunt.place)) : null;
      if (!dir) continue;
      const s = this.project(dir);
      if (s.z < 0) continue;
      star(ctx, s.x, s.y - 14, 7, "#ffd166");
    }

    // Pads.
    const pads = def.padLayout === "none" ? [] : padDirs(def);
    const known = new Set(you?.pads ?? []);
    const p = this.game.player.pos;
    const here = def.padLayout === "none" ? -1 : safePadAt(def, p.x, p.y, p.z);
    pads.forEach((d, i) => {
      const s = this.project(d);
      if (s.z < 0) return;
      const got = known.has(i);
      ctx.lineWidth = 2;
      ctx.strokeStyle = got ? "#72f1b8" : "#c9c2e0aa";
      ctx.fillStyle = i === 0 ? "#ffd8a8" : got ? "#36f9f6" : "#0008";
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === this.hoverPad ? 9 : 7, 0, Math.PI * 2);
      if (got || i === 0) ctx.fill();
      ctx.stroke();
      if (i === here) {
        ctx.strokeStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Portus: portals, the shop and the Hall of Firsts.
    if (def.padLayout === "none") {
      const up: Dir = [0, 1, 0];
      const marks: [Dir, string, string][] = [
        [objectDir(WORLD_OBJECT_BY_ID.get("juno_vale")!), "Portus Exchange", "#ffd166"],
        [objectDir(WORLD_OBJECT_BY_ID.get("hall_wall")!), "Hall of Firsts", "#ff7edb"],
      ];
      const f = tangentFrame(up);
      (["Arcadia", "Hollowmere", "Meridian"] as const).forEach((name, i) => {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        const t = [f.east[0] * Math.cos(a) + f.north[0] * Math.sin(a), f.east[1] * Math.cos(a) + f.north[1] * Math.sin(a), f.east[2] * Math.cos(a) + f.north[2] * Math.sin(a)];
        marks.push([norm([up[0] + (t[0]! * 17) / def.radius, up[1] + (t[1]! * 17) / def.radius, up[2] + (t[2]! * 17) / def.radius]), `${name} portal`, "#36f9f6"]);
      });
      for (const [d, label, col] of marks) {
        const s = this.project(d);
        if (s.z < 0) continue;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(label, s.x, s.y - 9);
      }
    }

    // Party members (same party id as you).
    const room = this.game.net.room;
    const state = room?.state as any;
    const mine = state?.players?.get(room?.sessionId ?? "");
    if (mine?.party) {
      state.players.forEach((pl: any, id: string) => {
        if (id === room!.sessionId || pl.party !== mine.party) return;
        const s = this.project(norm([pl.x, pl.y, pl.z]));
        if (s.z < 0) return;
        ctx.fillStyle = "#9cff6b";
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(pl.name, s.x, s.y - 9);
      });
    }

    // You: an arrow along your facing.
    const me = norm([p.x, p.y, p.z]);
    const sMe = this.project(me);
    if (sMe.z > 0) {
      const f = this.game.player.facing;
      const ahead = this.project(norm([me[0] + f.x * 0.05, me[1] + f.y * 0.05, me[2] + f.z * 0.05]));
      const ang = Math.atan2(ahead.y - sMe.y, ahead.x - sMe.x);
      ctx.save();
      ctx.translate(sMe.x, sMe.y);
      ctx.rotate(ang);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-7, 6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-7, -6);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }
  }

  private padAt(ev: MouseEvent): number {
    const def = BODIES[this.game.bodyId];
    if (def.padLayout === "none") return -1;
    const r = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = -1, bestD = 14;
    padDirs(def).forEach((d, i) => {
      const s = this.project(d);
      if (s.z < 0) return;
      const dd = Math.hypot(s.x - mx, s.y - my);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  }

  private hover(ev: MouseEvent) {
    const i = this.padAt(ev);
    this.hoverPad = i;
    if (i < 0) {
      this.tip.textContent = "";
      return;
    }
    const known = this.game.hud.you?.pads.includes(i);
    this.tip.textContent = `${padName(this.game.bodyId, i)} — ${known ? "discovered" : "undiscovered: touch it to unlock"}`;
  }

  private click(ev: MouseEvent) {
    const i = this.padAt(ev);
    if (i < 0) return;
    const def = BODIES[this.game.bodyId];
    const p = this.game.player.pos;
    const here = safePadAt(def, p.x, p.y, p.z);
    if (!this.game.hud.you?.pads.includes(i)) {
      this.tip.textContent = "Undiscovered — walk onto that pad once to unlock it";
      return;
    }
    if (here < 0) {
      this.tip.textContent = "Stand on a pad (inside its safe ring) to fast travel";
      return;
    }
    if (here === i) {
      this.tip.textContent = "You're already here";
      return;
    }
    this.game.net.room?.send("fastTravel", { pad: i });
    this.close();
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.strokeStyle = "#000a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}

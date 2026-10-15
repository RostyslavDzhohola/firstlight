// Main-thread side of the map atlas worker (world/mapAtlas.worker.ts): asks for the body's bake on
// arrival and for rendered views (the map's globe, the minimap's tile). Each view channel keeps at
// most one request in flight and remembers only the newest wanted one, so a drag never queues up.

import type { BodyId } from "@firstlight/shared";
import type { V3 } from "../social/compassMath.ts";
import type { MapWorkerIn, MapWorkerOut } from "../world/mapAtlas.worker.ts";

export interface ViewRequest {
  c: V3;
  rot: number;
  ppr: number;
  w: number;
  h: number;
  limb?: boolean;
}

export interface ViewImage {
  /** Drawable result (an ImageBitmap, or a canvas where workers can't make bitmaps). */
  image: CanvasImageSource;
  req: ViewRequest;
  body: BodyId;
  /** Faces baked when it was drawn (6 = complete). */
  baked: number;
}

type Done = (img: ViewImage | null) => void;

class Channel {
  inFlight: { id: number; req: ViewRequest; body: BodyId; done: Done } | null = null;
  wanted: { req: ViewRequest; body: BodyId; done: Done } | null = null;
}

export class MapAtlasClient {
  private worker: Worker | null = null;
  private body: BodyId | null = null;
  private seq = 0;
  private readonly channels = new Map<string, Channel>();
  private readonly byId = new Map<number, Channel>();
  private readonly faceListeners = new Set<(body: BodyId, baked: number) => void>();
  /** Faces of the current body baked so far (0..6). */
  baked = 0;

  /** Start (or keep) the bake for `body`; `near` is where the player stands (that face goes first). */
  bake(body: BodyId, near: V3) {
    if (this.body === body) return;
    this.body = body;
    this.baked = 0;
    const w = this.ensure();
    w?.postMessage({ type: "bake", body, near } satisfies MapWorkerIn);
  }

  /** The newest request on `channel` wins; `done` gets the image (or null if it couldn't be drawn). */
  render(channel: string, body: BodyId, req: ViewRequest, done: Done) {
    let ch = this.channels.get(channel);
    if (!ch) this.channels.set(channel, (ch = new Channel()));
    if (ch.inFlight) {
      ch.wanted = { req, body, done };
      return;
    }
    this.send(ch, req, body, done);
  }

  onFace(cb: (body: BodyId, baked: number) => void): () => void {
    this.faceListeners.add(cb);
    return () => this.faceListeners.delete(cb);
  }

  private send(ch: Channel, req: ViewRequest, body: BodyId, done: Done) {
    const w = this.ensure();
    if (!w) return done(null);
    const id = ++this.seq;
    ch.inFlight = { id, req, body, done };
    this.byId.set(id, ch);
    const msg: MapWorkerIn = { type: "render", id, body, c: req.c, rot: req.rot, ppr: req.ppr, w: Math.max(1, Math.round(req.w)), h: Math.max(1, Math.round(req.h)), limb: !!req.limb };
    w.postMessage(msg);
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    try {
      this.worker = new Worker(new URL("../world/mapAtlas.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      console.warn("[map] atlas worker unavailable", e);
      return null;
    }
    this.worker.onmessage = (e: MessageEvent<MapWorkerOut>) => this.receive(e.data);
    this.worker.onerror = (e) => console.error("[map] atlas worker error", e.message);
    return this.worker;
  }

  private receive(m: MapWorkerOut) {
    if (m.type === "face") {
      if (m.body !== this.body) return;
      this.baked = m.baked;
      for (const l of this.faceListeners) l(m.body, m.baked);
      return;
    }
    const ch = this.byId.get(m.id);
    this.byId.delete(m.id);
    if (!ch || ch.inFlight?.id !== m.id) return;
    const { req, body, done } = ch.inFlight;
    ch.inFlight = null;
    let image: CanvasImageSource | null = m.bitmap;
    if (!image && m.pixels) {
      const c = document.createElement("canvas");
      c.width = m.w;
      c.height = m.h;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(m.pixels), m.w, m.h), 0, 0);
      image = c;
    }
    done(image ? { image, req, body, baked: m.baked } : null);
    const next = ch.wanted;
    ch.wanted = null;
    if (next) this.send(ch, next.req, next.body, next.done);
  }
}

/** One atlas worker for the session (re-bakes on travel). */
export const mapAtlas = new MapAtlasClient();

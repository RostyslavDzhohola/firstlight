// Web Worker: decodes an HD town strip (a WebP grid, gridLayers.ts) to RGBA layer bytes off the main
// thread. Like the shipped strips' decode (townAssets.ts decodeStrip) it draws through a 2D canvas,
// which zeroes the colour where the cutout mask is 0, so the material's premultiplied sampling holds.

import { gridToLayers } from "./gridLayers.ts";

export interface StripJob {
  id: number;
  blob: Blob;
  size: number;
  layers: number;
  cols: number;
}
export type StripResult = { id: number; data: ArrayBuffer } | { id: number; error: string };

const scope = self as unknown as { postMessage(m: StripResult, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<StripJob>) => void) | null };

scope.onmessage = async (e) => {
  const { id, blob, size, layers, cols } = e.data;
  try {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const w = bmp.width, h = bmp.height;
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2D canvas in the worker");
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
    const out = gridToLayers(px, w, h, size, layers, cols);
    scope.postMessage({ id, data: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

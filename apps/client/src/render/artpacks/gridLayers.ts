// The HD town strips are grids (WebP's largest side is 16383 px, and 16 layers of 1024 px make 16384):
// layer i sits at column i % cols, row ⌊i / cols⌋ (tools/blender/portus/pack.py save_strip). The
// array texture wants the layers one after another, each top-down.

/** RGBA bytes of a `cols`-column grid image → `layers` consecutive size² layers (a one-column strip as is). */
export function gridToLayers(px: Uint8Array, width: number, height: number, size: number, layers: number, cols: number): Uint8Array {
  const rows = Math.ceil(layers / cols);
  if (width !== size * cols || height !== size * rows || px.length !== width * height * 4) {
    throw new Error(`layer strip: ${width}×${height} is not a ${cols}-column grid of ${layers} layers of ${size} px`);
  }
  if (cols === 1) return px;
  const out = new Uint8Array(size * size * layers * 4);
  const row = size * 4;
  for (let l = 0; l < layers; l++) {
    const gx = (l % cols) * size, gy = Math.floor(l / cols) * size;
    for (let y = 0; y < size; y++) {
      const src = ((gy + y) * width + gx) * 4;
      out.set(px.subarray(src, src + row), (l * size + y) * row);
    }
  }
  return out;
}

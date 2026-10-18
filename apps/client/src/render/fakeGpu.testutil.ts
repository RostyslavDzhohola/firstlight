// Test helper (imported only by *.test.ts): a recording stand-in for the GPU under three's real
// backends, so the renderer's own managers and backend code (bindings, uniform uploads, bind groups,
// pipelines, draws) run unchanged in node. WebGL2: a WebGL2 context whose calls are no-ops except
// the uniform-buffer ones it keeps (each buffer's bytes as uploaded, the buffers bound to each
// uniform-block index). WebGPU: a device whose uniform buffers keep the bytes queue.writeBuffer put
// in them, whose bind groups keep their entries, and whose render passes keep the groups bound per
// index. Every draw is recorded with what it reads, as the GPU would read it: WebGL2 at the draw call,
// WebGPU at queue.submit (every writeBuffer before a submit lands before its commands run).

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A GPU uniform buffer: a WebGLBuffer or a GPUBuffer stand-in. */
export type GpuBuffer = object;

export interface GpuDraw {
  /** What the spy on the backend's draw was drawing (a three RenderObject), or null. */
  tag: unknown;
  /** Frame number (FakeGpu.frame when drawn). */
  frame: number;
  /** WebGL2: the buffer bound at each uniform-block index; WebGPU: the bind group set at each index. */
  bound: Map<number, object>;
  /** The bytes of each uniform buffer the draw reads, as the GPU reads them. */
  bytes: Map<GpuBuffer, Uint8Array>;
}

export interface FakeGpu {
  /** The draws recorded so far. */
  draws: GpuDraw[];
  /** Set by the caller per frame. */
  frame: number;
  /** Set by the draw spy while three's backend draws a render object. */
  tag: unknown;
  /** The uniform buffers a draw reads (WebGL2: bound per index; WebGPU: in its bound groups' entries). */
  buffersOf(draw: GpuDraw): GpuBuffer[];
  /** WebGPU: a bind group's entries as created ({ binding, resource }). */
  entriesOf(group: object): { binding: number; resource: any }[];
}

const bytesOf = (data: ArrayBufferView | ArrayBuffer, offset = 0, length?: number): Uint8Array => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data, offset, length);
  const per = (data as any).BYTES_PER_ELEMENT ?? 1;
  const start = data.byteOffset + offset * per;
  const size = length !== undefined && length > 0 ? length * per : data.byteLength - offset * per;
  return new Uint8Array(data.buffer, start, size);
};

/** A WebGL2 context for three's WebGLBackend (pass it as the canvas's getContext result). */
export function fakeWebGL2(): { gl: any; gpu: FakeGpu } {
  const consts = new Map<string, number>();
  const names = new Map<number, string>();
  let next = 0x8000;
  const k = (name: string) => {
    let v = consts.get(name);
    if (v === undefined) {
      v = next++;
      consts.set(name, v);
      names.set(v, name);
    }
    return v;
  };
  const buffers = new Map<GpuBuffer, Uint8Array>();
  const bases = new Map<number, GpuBuffer>();
  let boundUniform: GpuBuffer | null = null;
  const gpu: FakeGpu = {
    draws: [],
    frame: 0,
    tag: null,
    buffersOf: (d) => [...d.bound.values()],
    entriesOf: () => [],
  };
  const draw = () => {
    const bytes = new Map<GpuBuffer, Uint8Array>();
    for (const b of bases.values()) bytes.set(b, (buffers.get(b) ?? new Uint8Array(0)).slice());
    gpu.draws.push({ tag: gpu.tag, frame: gpu.frame, bound: new Map(bases), bytes });
  };
  const own: Record<string, (...a: any[]) => any> = {
    getParameter: (p: number) => {
      const n = names.get(p) ?? "";
      if (n === "VIEWPORT" || n === "SCISSOR_BOX") return new Int32Array([0, 0, 800, 600]);
      if (n === "VERSION") return "WebGL 2.0";
      if (n === "SHADING_LANGUAGE_VERSION") return "WebGL GLSL ES 3.00";
      if (n === "MAX_TEXTURE_IMAGE_UNITS" || n === "MAX_COMBINED_TEXTURE_IMAGE_UNITS") return 16;
      if (n.startsWith("MAX_")) return 16384;
      return 0;
    },
    getSupportedExtensions: () => [],
    getExtension: () => null,
    getContextAttributes: () => ({ alpha: true, antialias: false, depth: true, stencil: false }),
    isContextLost: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    checkFramebufferStatus: () => k("FRAMEBUFFER_COMPLETE"),
    getUniformLocation: () => ({}),
    getUniformBlockIndex: () => 0,
    getAttribLocation: () => 0,
    getError: () => 0,
    bindBuffer: (target: number, b: GpuBuffer | null) => {
      if (target === k("UNIFORM_BUFFER")) boundUniform = b;
    },
    bufferData: (target: number, data: number | ArrayBufferView, _usage: number) => {
      if (target !== k("UNIFORM_BUFFER") || !boundUniform) return;
      buffers.set(boundUniform, typeof data === "number" ? new Uint8Array(data) : bytesOf(data).slice());
    },
    bufferSubData: (target: number, dstByteOffset: number, src: ArrayBufferView, srcOffset = 0, length = 0) => {
      if (target !== k("UNIFORM_BUFFER") || !boundUniform) return;
      buffers.get(boundUniform)!.set(bytesOf(src, srcOffset, length), dstByteOffset);
    },
    bindBufferBase: (target: number, index: number, b: GpuBuffer) => {
      if (target === k("UNIFORM_BUFFER")) bases.set(index, b);
    },
    drawElements: draw,
    drawArrays: draw,
    drawElementsInstanced: draw,
    drawArraysInstanced: draw,
  };
  const gl = new Proxy({}, {
    get(_t, p) {
      if (typeof p !== "string") return undefined;
      if (p === "canvas") return { width: 800, height: 600 };
      if (p === "drawingBufferWidth") return 800;
      if (p === "drawingBufferHeight") return 600;
      if (p in own) return own[p];
      if (/^[A-Z0-9_]+$/.test(p)) return k(p);
      if (p.startsWith("create") || p === "fenceSync") return () => ({ kind: p.slice(6) });
      return () => undefined;
    },
  });
  return { gl, gpu };
}

/** An object answering any method with another such object (WebGPU's many small objects). */
function stub(own: Record<string, any> = {}): any {
  return new Proxy(own, {
    get(t, p) {
      if (p in t) return (t as any)[p];
      if (typeof p !== "string" || p === "then") return undefined;
      return () => stub();
    },
  });
}

/** WebGPU's globals three reads (usage flags, the bundle encoder class), and the canvas format. */
export const WEBGPU_GLOBALS = {
  navigator: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPURenderBundleEncoder: class {},
};

/** A GPUDevice for three's WebGPUBackend (the renderer's `device` parameter) and a canvas context. */
export function fakeWebGPU(): { device: any; context: any; gpu: FakeGpu } {
  const bytes = new WeakMap<GpuBuffer, Uint8Array>();
  const entries = new WeakMap<object, { binding: number; resource: any }[]>();
  const pending: GpuDraw[] = [];
  const gpu: FakeGpu = {
    draws: [],
    frame: 0,
    tag: null,
    buffersOf: (d) => [...d.bound.values()].flatMap((g) => (entries.get(g) ?? []).map((e) => e.resource?.buffer).filter((b) => b && bytes.has(b))),
    entriesOf: (g) => entries.get(g) ?? [],
  };
  const texture = (d: any) =>
    stub({
      width: d?.size?.width ?? d?.size?.[0] ?? 1,
      height: d?.size?.height ?? d?.size?.[1] ?? 1,
      depthOrArrayLayers: d?.size?.depthOrArrayLayers ?? d?.size?.[2] ?? 1,
      mipLevelCount: d?.mipLevelCount ?? 1,
      format: d?.format,
      createView: () => stub(),
      destroy() {},
    });
  const pass = () => {
    const bound = new Map<number, object>();
    const draw = () => {
      const d: GpuDraw = { tag: gpu.tag, frame: gpu.frame, bound: new Map(bound), bytes: new Map() };
      gpu.draws.push(d);
      pending.push(d);
    };
    return stub({ setBindGroup: (i: number, g: object) => void bound.set(i, g), draw, drawIndexed: draw, drawIndirect: draw, drawIndexedIndirect: draw });
  };
  const device = stub({
    features: new Set<string>(["float32-filterable", "core-features-and-limits"]),
    limits: new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : 65536) }),
    lost: new Promise(() => {}),
    queue: stub({
      writeBuffer: (b: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset = 0, size?: number) => {
        bytes.get(b)?.set(bytesOf(data, dataOffset, size), offset);
      },
      submit: () => {
        // the commands run now: each draw reads its buffers as every write so far left them
        for (const d of pending.splice(0)) for (const b of gpu.buffersOf(d)) d.bytes.set(b, bytes.get(b)!.slice());
      },
      onSubmittedWorkDone: async () => {},
    }),
    createBuffer: (d: any) => {
      const size = d.size as number;
      const b = stub({ size, label: d.label, mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(size), unmap() {}, destroy() {} });
      if (d.usage & WEBGPU_GLOBALS.GPUBufferUsage.UNIFORM) bytes.set(b, new Uint8Array(size));
      return b;
    },
    createBindGroup: (d: any) => {
      const g = stub({ label: d.label });
      entries.set(g, d.entries.map((e: any) => ({ binding: e.binding, resource: e.resource }))); // three reuses the descriptor
      return g;
    },
    createTexture: texture,
    createShaderModule: () => stub({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: async () => stub(),
    createCommandEncoder: () => stub({ beginRenderPass: pass, finish: () => stub() }),
    pushErrorScope() {},
    popErrorScope: async () => null,
  });
  const context = stub({ configure() {}, getCurrentTexture: () => texture({ size: { width: 800, height: 600 }, format: "bgra8unorm" }) });
  return { device, context, gpu };
}

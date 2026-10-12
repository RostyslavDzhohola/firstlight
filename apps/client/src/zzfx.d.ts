declare module "zzfx" {
  export const ZZFX: { buildSamples: (...p: (number | undefined)[]) => number[]; sampleRate: number; volume: number };
  export function zzfx(...p: (number | undefined)[]): AudioBufferSourceNode;
}

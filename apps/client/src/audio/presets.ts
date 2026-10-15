// ZzFX presets: every sound is synthesised from these numbers (no sample files). Since D-sfx-1 they
// are the fallback for the ElevenLabs samples (sounds.ts): a sound without a loaded file plays its
// preset. No imports, so the sample tooling (`tools/sfx`) can render them in Node to match loudness.

export type Preset = readonly (number | undefined)[];

// ZzFX parameter order: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve,
// slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay,
// sustainVolume, decay, tremolo, filter.
export const PRESETS = {
  carbine: [1.1, 0.05, 420, 0.005, 0.02, 0.08, 4, 1.6, -6, , , , , 0.8, , , , 0.6, 0.03],
  scatterpipe: [1.7, 0.05, 120, 0.005, 0.05, 0.25, 4, 1.9, , , , , , 1.5, , 0.4, , 0.5, 0.08],
  stillshot: [1.9, 0.02, 300, 0.005, 0.06, 0.45, 4, 2.4, -4, , , , , 1, , 0.2, 0.05, 0.6, 0.1],
  hexquill: [0.9, 0.05, 820, 0.02, 0.04, 0.15, 1, 1.5, 12, , 200, 0.05, , , , , , 0.7, 0.05],
  emberglass: [1.2, 0.05, 200, 0.05, 0.1, 0.3, 3, 2, -2, , , , , 0.6, , 0.2, , 0.7, 0.1],
  stormcoil: [1.3, 0.05, 1200, 0.01, 0.08, 0.2, 3, 2.5, , , , , 0.02, 2, 30, 0.1, , 0.5, 0.05],
  longbow: [0.9, 0.05, 520, 0.01, 0.01, 0.12, 2, 1.2, -20, , , , , , , , , 0.8],
  comet: [1.5, 0.05, 90, 0.04, 0.2, 0.4, 3, 1.5, 2, , , , , 0.8, , 0.2, , 0.7, 0.2],
  grenade: [0.8, 0.05, 300, 0.01, 0.02, 0.1, 3, 1.5, -10],
  explosion: [2.6, 0.1, 60, 0.02, 0.2, 0.9, 4, 2.5, -1, , , , , 1.5, , 0.6, 0.2, 0.4, 0.4],
  swing: [0.7, 0.1, 300, 0.01, 0.02, 0.1, 3, 1.5, -30, , , , , , , , , 0.5],
  meleeHit: [1.3, 0.05, 150, 0.005, 0.03, 0.15, 4, 2.5, -10, , , , , 1, , 0.3, , 0.6],
  impact: [0.6, 0.1, 200, 0.005, 0.01, 0.08, 4, 2, -5, , , , , 1.2],
  // The owner's "annoying ping" was a 1.6 kHz triangle on every landed hit; now a short falling "tok".
  hitmark: [0.6, 0.05, 440, , 0.005, 0.04, 0, 1, -60, , , , , 0.4, , , , 0.5],
  hurt: [1, 0.05, 220, 0.01, 0.05, 0.2, 2, 2, -6, , , , , 0.5, , , , 0.7],
  coins: [0.8, 0, 1200, 0.01, 0.05, 0.2, 1, 1.5, , , 400, 0.05],
  levelUp: [1.1, 0, 500, 0.05, 0.2, 0.4, 1, 1, , , 300, 0.1, 0.1],
  death: [1.4, 0, 300, 0.05, 0.3, 0.8, 2, 1, -2, , , , , , , , , 0.5, 0.2],
  portal: [0.9, 0, 200, 0.4, 0.3, 0.6, 1, 0, 8, , , , , , , , , 0.6],
  // Was a 900 Hz triangle blip on every toast; now a soft low "tok" like the hit marker's.
  ui: [0.4, 0, 520, , 0.005, 0.03, 0, 1, -30],
  denied: [0.5, 0, 160, , 0.04, 0.08, 2, 1],
  whistle: [0.6, 0, 1250, 0.02, 0.12, 0.12, 0, 1, 4, , 420, 0.1, , , , , , 0.8, 0.04], // two-note horse whistle
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

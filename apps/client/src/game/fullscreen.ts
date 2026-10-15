// Fullscreen with Keyboard Lock (D-controls-3). Play goes fullscreen; where the Keyboard Lock API exists
// (Chromium, and only while in fullscreen) a short Esc reaches the game instead of leaving fullscreen:
// the first Esc opens the pause menu, the next one goes straight back into the game. Holding Esc
// still leaves fullscreen (the browser says so on entry). Without it (Safari, Firefox) Esc frees the
// pointer and leaves fullscreen as usual, and the windowed page works the same way (pauseFlow.ts).

type KeyboardLock = { lock(keys?: string[]): Promise<void>; unlock(): void };

function keyboard(): KeyboardLock | undefined {
  return (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard?.lock ? ((navigator as Navigator & { keyboard: KeyboardLock }).keyboard) : undefined;
}

export function fullscreenAvailable(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenEnabled;
}

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

/** Enter fullscreen (call inside a click or key press) and keep Esc for the game while there. */
export async function enterFullscreen(): Promise<void> {
  await document.documentElement.requestFullscreen?.().catch(() => {});
  if (isFullscreen()) await keyboard()?.lock(["Escape"]).catch(() => {});
}

export async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) {
    keyboard()?.unlock();
    await document.exitFullscreen?.().catch(() => {});
  } else await enterFullscreen();
}

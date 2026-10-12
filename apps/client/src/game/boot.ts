// First boot (F12 S6): Play → renderer → UI → first arrival. A failure must leave the game retryable
// and say what went wrong with a Retry button (the singleton used to be set before start() worked,
// so every later Play click did nothing). Pure (no DOM, no three): main.ts imports it on the landing
// page, and it is unit-tested.

import { ConnectionLost } from "./arrival.ts";

export type BootState = "idle" | "booting" | "running" | "failed";

/** Runs `run` until it succeeds once: overlapping calls share an attempt, a failure can be retried. */
export class BootGate {
  state: BootState = "idle";
  error: unknown = null;
  private attempt: Promise<void> | null = null;

  constructor(private readonly run: () => Promise<void>) {}

  start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.attempt) return this.attempt;
    this.state = "booting";
    this.error = null;
    this.attempt = this.run().then(
      () => {
        this.state = "running";
        this.attempt = null;
      },
      (e: unknown) => {
        this.state = "failed";
        this.error = e;
        this.attempt = null;
        throw e;
      },
    );
    return this.attempt;
  }
}

/** WebGPURenderer.init() failed (no WebGPU and no WebGL2, or the GPU process refused). */
export class RendererUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super(`renderer: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RendererUnavailable";
  }
}

export interface BootFailure {
  title: string;
  text: string;
  /** "retry" runs the boot again in place; "reload" reloads the page (a failed import is cached). */
  action: "retry" | "reload";
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** /api/play refusals that the removal screen (social/screens.ts) explains on its own. */
function refused(e: unknown): boolean {
  const m = message(e);
  return m === "banned" || m === "kicked" || (e instanceof ConnectionLost && e.action === "removed");
}

/** What to show for a failed first boot; null when another screen already explains it. */
export function describeBootFailure(e: unknown): BootFailure | null {
  if (refused(e)) return null;
  if (e instanceof RendererUnavailable) {
    return {
      title: "Graphics didn't start",
      text: "This browser couldn't start WebGPU or WebGL2. Check that hardware acceleration is on, or try an up-to-date Chrome, Edge, Firefox or Safari.",
      action: "retry",
    };
  }
  const m = message(e);
  if (/dynamically imported module|importing a module script failed/i.test(m)) {
    return { title: "The game didn't finish downloading", text: "Your connection dropped while the game was loading. Reload to try again.", action: "reload" };
  }
  return { title: "Couldn't reach the world", text: "The game server didn't answer. Check your connection and try again; your character is safe.", action: "retry" };
}

/** Reconnect loop: keep trying through drops and timeouts; stop when the server refused us. */
export function shouldKeepReconnecting(e: unknown): boolean {
  return !refused(e);
}

/** The screens a failed boot can end on (main.ts wires the real ones; tests record the calls). */
export interface BootScreens {
  hideLoading(): void;
  /** The loading card's error with Retry / Reload. */
  showError(f: BootFailure): void;
  /** The removal screen (kicked, banned, playing elsewhere): a close code or an /api/play refusal. */
  showRemoved(reason: number | string): void;
}

/** What a removal is called on the removal screen: the close code, or the /api/play refusal. */
function removalReason(e: unknown): number | string | null {
  if (e instanceof ConnectionLost && e.action === "removed" && e.code !== null) return e.code;
  const m = message(e);
  return m === "banned" || m === "kicked" ? m : null;
}

/**
 * Run the first boot; if it fails, end on a screen, never a blank page: removed (a removal close
 * during the first arrival, or a refusal) → the removal screen; anything else → the error with
 * Retry. Returns whether the boot succeeded.
 */
export async function runBoot(start: () => Promise<void>, ui: BootScreens): Promise<boolean> {
  try {
    await start();
    return true;
  } catch (e) {
    console.error("[boot] failed", e);
    const removed = removalReason(e);
    if (removed !== null) {
      ui.hideLoading();
      ui.showRemoved(removed); // idempotent: a refusal's screen may already be up
    } else ui.showError(describeBootFailure(e)!);
    return false;
  }
}

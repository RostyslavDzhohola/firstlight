// Client configuration: endpoints from build-time env, feature flags from the URL (kill switches).

import { dataFastScript } from "./home/datafast.ts";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:2567",
  assetBase: (import.meta.env.VITE_ASSET_BASE as string | undefined) ?? "/assets-dev",
  /** Boss voice lines (ElevenLabs, never in git) live on the asset Worker as a versioned set. */
  voiceBase: (import.meta.env.VITE_VOICE_BASE as string | undefined) ?? "https://firstlight-assets.rosty-build.workers.dev/v/voice-1",
  publicRepo: import.meta.env.VITE_PUBLIC_REPO === "true",
  repoUrl: "https://github.com/RostyslavDzhohola/firstlight",
  /** The owner's X handle for "Follow on X" in the share row; unset hides the button (6e). */
  xHandle: (import.meta.env.VITE_X_HANDLE as string | undefined) ?? "",
  /** DataFast's script as vite.config.ts puts it in the page (null: none), for the privacy note (6f). */
  datafast: dataFastScript(import.meta.env as Record<string, string | undefined>),
};

/** URL flags (also ?cpuslow=N for the F11 weak-laptop profile): ?nobloom ?nofog ?nosky ?nograss ?notrees ?nowater ?noshadows ?noao ?noparticles ?nopost ?nochars ?nodestruct ?nohorses ?webgl ?tier=… ?bench */
export const flags = {
  has(name: string): boolean {
    return params.has(name);
  },
  get(name: string): string | null {
    return params.get(name);
  },
};

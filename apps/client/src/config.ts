// Client configuration: endpoints from build-time env, feature flags from the URL (kill switches).

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:2567",
  assetBase: (import.meta.env.VITE_ASSET_BASE as string | undefined) ?? "/assets-dev",
  publicRepo: import.meta.env.VITE_PUBLIC_REPO === "true",
  repoUrl: "https://github.com/RostyslavDzhohola/firstlight",
};

/** URL flags: ?nobloom ?nofog ?nosky ?nograss ?notrees ?nowater ?noshadows ?noao ?noparticles ?nopost ?nochars ?nodestruct ?webgl ?tier=… ?bench */
export const flags = {
  has(name: string): boolean {
    return params.has(name);
  },
  get(name: string): string | null {
    return params.get(name);
  },
};

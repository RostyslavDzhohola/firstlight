// DataFast tracking script (6f), injected into index.html at build time by vite.config.ts only when
// VITE_DATAFAST_WEBSITE_ID and VITE_DATAFAST_DOMAIN are set; without them the page has no
// third-party script at all. Snippet per https://datafa.st/docs/script-configuration (2026-10-15).
//
// Cookieless by default (https://datafa.st/docs/gdpr-cookieless-tracking): no visitor cookies, so no
// cookie banner for DataFast. Turn on "Cookieless / privacy mode" in the DataFast website settings
// to match; VITE_DATAFAST_COOKIELESS=false switches to the cookie script.

export interface DataFastEnv {
  VITE_DATAFAST_WEBSITE_ID?: string;
  VITE_DATAFAST_DOMAIN?: string;
  VITE_DATAFAST_COOKIELESS?: string;
}

export interface DataFastScript {
  src: string;
  websiteId: string;
  domain: string;
  cookieless: boolean;
}

/** The script to inject, or null when DataFast isn't configured (or the values look wrong). */
export function dataFastScript(env: DataFastEnv): DataFastScript | null {
  const websiteId = (env.VITE_DATAFAST_WEBSITE_ID ?? "").trim();
  const domain = (env.VITE_DATAFAST_DOMAIN ?? "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(websiteId)) return null;
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return null;
  const cookieless = (env.VITE_DATAFAST_COOKIELESS ?? "").trim().toLowerCase() !== "false";
  return { src: `https://datafa.st/js/script${cookieless ? ".cookieless" : ""}.js`, websiteId, domain, cookieless };
}

/** The page's one-line analytics note: only claim "cookieless" when the cookieless script is the one in the page. */
export function dataFastNote(s: DataFastScript | null): string | null {
  if (!s) return null;
  return s.cookieless ? "Cookieless analytics by DataFast" : "Analytics by DataFast, which sets cookies";
}

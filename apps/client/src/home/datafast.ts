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

/**
 * Inline script placed before DataFast's tag: automated browsers (navigator.webdriver: Playwright,
 * CDP, our journeys and smoke runs) and test URLs (?e2e, ?bench, ?offline) set DataFast's own opt-out
 * flag (https://datafa.st/docs/excluding-analytics), so test runs don't count as visits. Any other
 * visit removes the flag, so one test visit doesn't hide that browser from DataFast forever (#44).
 * Trade-off: someone who set `datafast_ignore` by hand to hide their own visits loses it on their
 * next normal visit; the owner wants to be counted, so that's fine. A player who opts out on the
 * home page's Privacy card (ANALYTICS_OPT_OUT_KEY) stays out on every visit (#12).
 */
export const DATAFAST_GUARD =
  'try{if(navigator.webdriver||/[?&](?:e2e|bench|offline)(?:[=&]|$)/.test(location.search)||localStorage.getItem("fl.noAnalytics")==="1")localStorage.setItem("datafast_ignore","true");else localStorage.removeItem("datafast_ignore")}catch(e){}';

/** The Privacy card's opt-out (localStorage "1"); DATAFAST_GUARD reads the same key. */
export const ANALYTICS_OPT_OUT_KEY = "fl.noAnalytics";

/**
 * The home page's Privacy card text (#12, owner 2026-10-18; review 2026-11-13 ship #6): who counts the
 * visits, whether that sets cookies (only claim "no cookies" for the cookieless script), what for, and
 * how to opt out. Our own funnel and error reports (net/beacon.ts) are always disclosed, with or
 * without DataFast; the DataFast lines only when it is in the page.
 */
export function privacyText(s: DataFastScript | null): string[] {
  return [
    ...(s
      ? [
          s.cookieless
            ? "The home page counts visits with DataFast's cookieless analytics: no cookies are set."
            : "The home page counts visits with DataFast analytics, which sets cookies in your browser.",
          "We use the counts only to see how many people visit and how many are online now. No ads, nothing sold.",
        ]
      : []),
    "The game itself keeps your guest character in this browser's storage so you can come back to it.",
    "The game also tells our own server, never a third party, which first steps a visit reached (Play pressed, the world loaded and how long it took, the tutorial's steps) and any error the page hits, with web addresses, emails and tokens taken out. Our server gives the visit a random id, which this browser keeps; nothing personal. Steps are kept 21 days and then only as daily totals, error reports 30 days. It is only so we can fix what stops new players.",
    `Do Not Track or Global Privacy Control in your browser turns that off. So does the button below${s ? ", which also stops DataFast counting this browser" : ""}: on this device, from the next page you open.`,
  ];
}

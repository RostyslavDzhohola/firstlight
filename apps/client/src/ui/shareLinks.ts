// Share row links (6e): the invite text, the mailto: invite and the "Follow on X" link. Pure (no DOM),
// so the rules are testable: the X link exists only for a valid handle from VITE_X_HANDLE.

/** Always the public site, never localhost or a preview URL. */
export const SHARE_URL = "https://firstlight.one4all.dev";
export const SHARE_TITLE = "FIRSTLIGHT";
export const SHARE_TEXT = "FIRSTLIGHT: an open world in your browser. Free, no download. Come play with me.";

/** A valid X handle (with or without the @), else null: the Follow button stays hidden. */
export function xHandle(raw: string | null | undefined): string | null {
  const h = (raw ?? "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

export function xFollowUrl(handle: string): string {
  return `https://x.com/intent/follow?screen_name=${encodeURIComponent(handle)}`;
}

export function inviteMailto(url = SHARE_URL): string {
  const subject = "Play FIRSTLIGHT with me";
  const body = `FIRSTLIGHT is a free open-world game that runs in the browser (no download, keyboard and mouse). Come find me in Portus:\n\n${url}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// The UI's surfaces (D-ui-1): flat translucent fills by default, no live backdrop blur (styles/tokens.css).
// `?blur=1` brings the old blurred look back for A/B recordings: `fl-blur` on <html>, which the
// stylesheets read. The Low tier (`fl-lowfx`, bind.ts) stays flat either way. Tiny on purpose: the home
// page runs it before the game bundle exists.

/** The URL asks for the old blurred look (`?blur=1`, or a bare `?blur`; `?blur=0` doesn't). */
export function blurLook(search: string): boolean {
  const v = new URLSearchParams(search).get("blur");
  return v !== null && v !== "0" && v !== "false";
}

/** Put the look the URL asks for on `root` (document.documentElement). */
export function applyUiLook(root: { classList: { toggle(cls: string, on: boolean): unknown } }, search: string): void {
  root.classList.toggle("fl-blur", blurLook(search));
}

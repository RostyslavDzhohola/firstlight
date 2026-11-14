// Client error reports, made safe to keep (#85, review 2026-11-13 ship #3). The page runs these before
// it sends a report and the server runs them again on what arrives, so a report never carries a
// URL's query, fragment or credentials, a token in a path, an email (plain or percent-encoded), a
// bearer or JWT, or an arbitrary object someone rejected a promise with. What stays: the error's
// name and its words, and up to STACK_FRAMES stack frames reduced to function, file name and
// position.

export const REPORT_LIMITS = { message: 300, stack: 600, frame: 160 };
/** Stack frames a report keeps. */
export const STACK_FRAMES = 5;
/**
 * Characters a scrub function reads at most (review round two, finding 4): longer text is cut first,
 * before any pattern runs, so the cost is bounded whatever arrives, on the page and on the server.
 * Every pattern below is also anchored so it runs in linear time on what it does read.
 */
export const SCRUB_INPUT = 4096;
/** A stack is cut to this many characters, and each of its lines to SCRUB_LINE, before parsing. */
const STACK_INPUT = 8192;
const SCRUB_LINE = 480;

const ASSET_FILE = /^[\w.@-]{1,80}\.(?:m?js|cjs|ts|tsx|css|wasm|html?)$/i;
/** Path segments after which the next segment is a credential (reset links, invites, magic links…). */
const SENSITIVE_SEGMENT = /^(?:reset[\w-]*|verify[\w-]*|magic[\w-]*|invite[\w-]*|claim|token|tokens|otp|confirm[\w-]*|activate|unsubscribe|session|sessions|auth|callback|key|keys|secret|share)$/i;

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029;

/**
 * `text` cut to `max` characters. A cut through a word drops that whole word (a half email or token
 * would no longer look like one to the rules), and "…" marks the cut.
 */
export function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (!isSpace(text.charCodeAt(max))) while (end > 0 && !isSpace(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

function decodePercent(s: string): string {
  // Printable ASCII only (an encoded email, URL or token becomes visible to the rules below), as many
  // layers as were stacked (a few at most: each pass is linear and the input is bounded).
  let t = s;
  for (let i = 0; i < 4 && t.includes("%"); i++) {
    const next = t.replace(/%([0-9a-f]{2})/gi, (m, h: string) => {
      const c = parseInt(h, 16);
      return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

/** A URL reduced to its origin and, for a script or asset, its file name (and line:column). */
function scrubUrl(raw: string): string {
  const pos = /((?::\d{1,7}){1,2})$/.exec(raw)?.[1] ?? "";
  const bare = pos ? raw.slice(0, -pos.length) : raw;
  let u: URL;
  try {
    u = new URL(bare);
  } catch {
    return "[url]";
  }
  if (!/^(?:https?|wss?|blob|file):$/.test(u.protocol)) return "[url]";
  // `host` is the bracketed IPv6 or name, and the port: never the userinfo.
  const origin = u.protocol === "blob:" || u.protocol === "file:" ? u.protocol : `${u.protocol}//${u.host}`;
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const file = ASSET_FILE.test(last) && !/\d{6,}|[A-Za-z0-9_-]{24,}/.test(last.replace(/\.[^.]+$/, "")) ? last : "";
  return `${origin}${file ? `/…/${file}` : u.pathname === "/" || !u.pathname ? "" : "/…"}${file ? pos : ""}`;
}

/** A URL match without the sentence punctuation or unbalanced bracket that followed it. Linear (review round three, nit 6): the first "[" is found once. */
function urlEnd(m: string): number {
  const open = m.indexOf("[");
  let end = m.length;
  for (;;) {
    const c = m[end - 1];
    if (c === "." || c === "," || c === ";" || c === "!" || c === "?") end--;
    else if (c === "]" && (open < 0 || open > end - 2)) end--; // no "[" before this "]"
    else return end;
  }
}

/** A run of text with a "/" in it: no query or fragment, and nothing after a sensitive segment. */
function scrubPath(token: string): string {
  const q = token.search(/[?#]/);
  const parts = (q >= 0 ? token.slice(0, q) : token).split("/");
  return parts.map((p, i) => (i > 0 && p && SENSITIVE_SEGMENT.test(parts[i - 1]!.replace(/^\W+/, "")) ? "[redacted]" : p)).join("/");
}

/**
 * Keys whose value is a credential (review round three, #5): these keys exactly, in any case, with
 * `_`, `-` or nothing between their words, followed by `=` or `:`. Never a longer word that only ends
 * in one of them, and never a bare `code` or `key`, so diagnostics stay readable: `status_code=`,
 * `error code:`, `shader code: WGSLValidationError`, `Duplicate key: name`. A long credential under
 * another key is still caught by the token and hex rules below.
 */
export const CREDENTIAL_KEYS: readonly string[] = [
  "token", "access_token", "refresh_token", "id_token", "auth_token", "session_token", "csrf_token", "xsrf_token", "api_token", "bearer_token", "oauth_token", "reset_token",
  "secret", "client_secret", "api_secret", "app_secret", "secret_key",
  "password", "passwd", "pwd", "passphrase",
  "otp", "otp_code", "verification_code", "auth_code", "authorization_code", "reset_code", "login_code",
  "api_key", "x_api_key", "access_key", "private_key",
  "auth", "authorization", "session", "session_id", "sid", "signature", "sig", "cookie", "set_cookie",
];
const CREDENTIAL = new RegExp(
  `(?<![\\w-])(${[...CREDENTIAL_KEYS].sort((a, b) => b.length - a.length).map((k) => k.replace(/_/g, "[-_]?")).join("|")})(\\s*[=:]\\s*)["']?[^\\s"',;&}]{6,}`,
  "gi",
);

/** Make any text from an error report safe to keep. Reads at most SCRUB_INPUT characters. */
export function scrubText(text: string): string {
  let t = decodePercent(boundText(text, SCRUB_INPUT));
  // Any `scheme://…` (any case; IPv6 brackets, userinfo and ports included), starting where a scheme can.
  t = t.replace(/(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'`<>(){}]*/g, (m) => {
    const end = urlEnd(m);
    return scrubUrl(m.slice(0, end)) + m.slice(end);
  });
  // Every other run with a "/" (relative, protocol-relative or scheme-less paths): see scrubPath.
  t = t.replace(/(?<![^\s"'`<>])[^\s"'`<>/]*\/[^\s"'`<>]*/g, (m) => scrubPath(m));
  t = t.replace(/\?[\w%.~+-]+=[^\s"'`<>()]*/g, ""); // a query string left without its path
  t = t.replace(/(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[jwt]");
  t = t.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]");
  t = t.replace(/(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  t = t.replace(CREDENTIAL, "$1$2[redacted]");
  t = t.replace(/\b[a-f0-9]{32,}\b/gi, "[hex]");
  // Long token-like runs (base64/base64url ids, API keys): letters and digits mixed, 24+ long.
  t = t.replace(/[A-Za-z0-9_+=-]{24,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[token]" : m));
  return t;
}

const FRAME_V8 = /^at\s+(?:(.{1,80}?)\s+\()?(.+?)\)?$/;
const FRAME_GECKO = /^([^@\s]{0,80})@(.+)$/;

/** A stack reduced to at most STACK_FRAMES frames, each `at fn (origin/…/file.js:l:c)`. Other lines go. */
export function scrubStack(stack: string): string {
  const out: string[] = [];
  for (const raw of boundText(stack, STACK_INPUT).split("\n")) {
    if (out.length >= STACK_FRAMES) break;
    const line = boundText(raw, SCRUB_LINE).trim();
    const v8 = FRAME_V8.exec(line);
    const gecko = v8 ? null : FRAME_GECKO.exec(line);
    const m = v8 ?? gecko;
    if (!m) continue;
    const fn = (m[1] ?? "").replace(/[^\w$.<>\[\] -]/g, "").slice(0, 60);
    const where = scrubText(m[2] ?? "").slice(0, 100);
    if (!/[:/]/.test(where) && !/native|anonymous/.test(where)) continue;
    out.push(`at ${fn ? `${scrubText(fn)} (${where})` : where}`.slice(0, REPORT_LIMITS.frame));
  }
  return out.join("\n").slice(0, REPORT_LIMITS.stack);
}

/**
 * What was thrown or rejected, as a message and a raw stack, without serialising it: an Error (or
 * anything with a string name and message) gives `Name: message`; a string itself; anything else
 * only its type, e.g. "Unhandled rejection (Object)".
 */
export function describeThrown(err: unknown): { message: string; stack: string } {
  if (err instanceof Error || (err && typeof err === "object" && typeof (err as Error).message === "string" && typeof (err as Error).name === "string")) {
    const e = err as Error;
    return { message: `${String(e.name).slice(0, 40)}: ${String(e.message)}`, stack: typeof e.stack === "string" ? e.stack : "" };
  }
  if (typeof err === "string") return { message: err, stack: "" };
  let type: string = err === null ? "null" : typeof err;
  if (err && typeof err === "object") {
    const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
    type = typeof name === "string" && /^[A-Za-z_$][\w$]{0,31}$/.test(name) ? name : "object";
    const evType = (err as { type?: unknown }).type;
    if (typeof evType === "string" && /^[a-z]{1,24}$/.test(evType)) type += ` ${evType}`;
  }
  return { message: `Unhandled rejection (${type})`, stack: "" };
}

/** A report's message and stack, scrubbed and size-limited (client before sending, server on arrival). */
export function scrubReport(message: string, stack: string): { message: string; stack: string } {
  return {
    message: scrubText(message).replace(/\s+/g, " ").trim().slice(0, REPORT_LIMITS.message),
    stack: scrubStack(stack),
  };
}

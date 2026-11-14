// Client error reports, made safe to keep (#85, review 2026-11-13 ship #3). The page runs these before
// it sends a report and the server runs them again on what arrives, so a report never carries a
// URL's query, fragment or credentials, a token in a path, an email (plain or percent-encoded), a
// bearer or JWT, or an arbitrary object someone rejected a promise with. What stays: the error's
// name and its words, and up to STACK_FRAMES stack frames reduced to function, file name and
// position.

export const REPORT_LIMITS = { message: 300, stack: 600, frame: 160 };
/** Stack frames a report keeps. */
export const STACK_FRAMES = 5;

const ASSET_FILE = /^[\w.@-]{1,80}\.(?:m?js|cjs|ts|tsx|css|wasm|html?)$/i;
/** Path segments after which the next segment is a credential (reset links, invites, magic links…). */
const SENSITIVE_SEGMENT = /^(?:reset[\w-]*|verify[\w-]*|magic[\w-]*|invite[\w-]*|claim|token|tokens|otp|confirm[\w-]*|activate|unsubscribe|session|sessions|auth|callback|key|keys|secret|share)$/i;

function decodePercent(s: string): string {
  // Printable ASCII only (an encoded email or token becomes visible to the rules below).
  let t = s;
  for (let i = 0; i < 2; i++) t = t.replace(/%([0-9a-f]{2})/gi, (m, h: string) => {
    const c = parseInt(h, 16);
    return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : m;
  });
  return t;
}

/** A URL reduced to its origin and, for a script or asset, its file name (and line:column). */
function scrubUrl(raw: string): string {
  const pos = /((?::\d+){1,2})$/.exec(raw)?.[1] ?? "";
  const bare = pos ? raw.slice(0, -pos.length) : raw;
  let u: URL;
  try {
    u = new URL(bare);
  } catch {
    return "[url]";
  }
  if (!/^(?:https?|wss?|blob|file):$/.test(u.protocol)) return "[url]";
  const origin = u.protocol === "blob:" || u.protocol === "file:" ? u.protocol : `${u.protocol}//${u.host}`;
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const file = ASSET_FILE.test(last) && !/\d{6,}|[A-Za-z0-9_-]{24,}/.test(last.replace(/\.[^.]+$/, "")) ? last : "";
  return `${origin}${file ? `/…/${file}` : u.pathname === "/" || !u.pathname ? "" : "/…"}${file ? pos : ""}`;
}

/** Path segments after a sensitive one are dropped (relative paths in messages). */
function scrubPath(path: string): string {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (SENSITIVE_SEGMENT.test(parts[i]!)) parts[i + 1] = "[redacted]";
  return parts.join("/");
}

/** Make any text from an error report safe to keep. */
export function scrubText(text: string): string {
  let t = decodePercent(text);
  t = t.replace(/\b(?:https?|wss?|blob|file):\/\/[^\s"'`<>()[\]{}]+/gi, (m) => scrubUrl(m.replace(/[.,;]+$/, "")) + (m.match(/[.,;]+$/)?.[0] ?? ""));
  // Relative paths: no query or fragment, nothing after a sensitive segment.
  t = t.replace(/(^|[\s"'`(=])(\/[^\s"'`<>()?#]*)([?#][^\s"'`<>()]*)?/g, (_m, pre: string, path: string) => `${pre}${scrubPath(path)}`);
  t = t.replace(/\?[\w%.~+-]+=[^\s"'`<>()]*/g, ""); // a query string left without its path
  t = t.replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[jwt]");
  t = t.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  t = t.replace(/\b(token|secret|password|passwd|pwd|otp|code|key|apikey|api_key|session|sid|auth|signature|sig)(\s*[=:]\s*)["']?[^\s"',;&}]+/gi, "$1$2[redacted]");
  t = t.replace(/\b[a-f0-9]{32,}\b/gi, "[hex]");
  // Long token-like runs (base64/base64url ids, API keys): letters and digits mixed, 24+ long.
  t = t.replace(/[A-Za-z0-9_+/=-]{24,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[token]" : m));
  return t;
}

const FRAME_V8 = /^\s*at\s+(?:(.{1,80}?)\s+\()?(.+?)\)?\s*$/;
const FRAME_GECKO = /^\s*([^@\s]{0,80})@(.+?)\s*$/;

/** A stack reduced to at most STACK_FRAMES frames, each `at fn (origin/…/file.js:l:c)`. Other lines go. */
export function scrubStack(stack: string): string {
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    if (out.length >= STACK_FRAMES) break;
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

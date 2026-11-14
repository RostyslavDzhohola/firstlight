// Who may read the root `pnpm dev`'s per-run sign-in key from the Vite dev server (vite.config.ts,
// /@firstlight/dev-key): this machine's own pages. The dev server listens on every interface
// (`host: true`, for phones on the LAN), so the key is never inside a served module; this answers
// only a loopback socket, a loopback Host (not a name rebound to 127.0.0.1), no proxy header, and a
// same-origin fetch. Used by the dev server only, never bundled.

const LOOPBACK = /^127\.\d+\.\d+\.\d+$/;
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "via", "x-forwarded-host"];

export function localPage(req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): boolean {
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const site = req.headers["sec-fetch-site"];
  return (
    (ip === "::1" || LOOPBACK.test(ip)) &&
    (host === "localhost" || host === "[::1]" || LOOPBACK.test(host)) &&
    !PROXY_HEADERS.some((h) => req.headers[h] !== undefined) &&
    (site === undefined || site === "same-origin")
  );
}

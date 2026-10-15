// DataFast visit counts for the home page (6f): "online now" (visitors active in the last 10 minutes)
// and all-time visits (sessions), from DataFast's Analytics API with the website key (`df_…`,
// DATAFAST_API_KEY). The key stays on the server: it is never logged or sent to a client.
// Docs: https://datafa.st/docs/api/website/analytics/realtime and …/overview (checked 2026-10-15).
//
// Cached for at least a minute and fetched by one request at a time, however many players poll the
// home page; a failure keeps the last good numbers and waits a full minute before trying again.

export interface VisitStats {
  /** Visitors with a pageview in the last 10 minutes. */
  online: number;
  /** All-time visits (DataFast sessions). */
  total: number;
}

export interface VisitSource {
  readonly configured: boolean;
  /** Cached numbers, or null when DataFast isn't configured or hasn't answered yet. */
  get(): Promise<VisitStats | null>;
}

export interface DataFastOptions {
  apiKey: string;
  /** Minimum cache lifetime; values under 60 s are raised to 60 s. */
  ttlMs?: number;
  timeoutMs?: number;
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const DATAFAST_MIN_TTL_MS = 60_000;

/** `{status, data: [{…}]}` (or a bare object) → the first row's field, if it's a finite number. */
function field(json: unknown, name: string): number | null {
  const data = (json as { data?: unknown } | null)?.data;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const v = row?.[name];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

export function dataFastVisits(opts: DataFastOptions): VisitSource {
  const key = opts.apiKey.trim();
  const ttl = Math.max(DATAFAST_MIN_TTL_MS, opts.ttlMs ?? DATAFAST_MIN_TTL_MS);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const base = (opts.base ?? "https://datafa.st").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let value: VisitStats | null = null;
  let checkedAt = -Infinity;
  let inflight: Promise<VisitStats | null> | null = null;
  let failing = false;

  const call = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`DataFast ${path.split("?")[0]} answered ${res.status}`);
    return res.json();
  };

  const refresh = async (): Promise<VisitStats | null> => {
    try {
      const [rt, ov] = await Promise.all([call("/api/v1/analytics/realtime?fields=visitors"), call("/api/v1/analytics/overview?fields=visitors,sessions")]);
      const online = field(rt, "visitors");
      const total = field(ov, "sessions") ?? field(ov, "visitors");
      if (online === null || total === null) throw new Error("DataFast answered without visitor numbers");
      value = { online, total };
      failing = false;
    } catch (err) {
      // Once per failure streak; the message never contains the key.
      if (!failing) console.warn(`datafast: ${(err as Error)?.message ?? err}`);
      failing = true;
    } finally {
      checkedAt = now();
      inflight = null;
    }
    return value;
  };

  return {
    configured: key.length > 0,
    async get() {
      if (!key) return null;
      if (now() - checkedAt < ttl) return value;
      inflight ??= refresh();
      return inflight;
    },
  };
}

// Tiny server-rendered HTML kit for /admin and /stats: escaping, page shell, bars. No scripts.

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 1000) / 10}%`;
}

/** Horizontal bars for a label → count map (keeps the given order). */
export function bars(entries: [string, number][], fmt: (n: number) => string = String): string {
  if (!entries.length) return `<p class="muted">No data yet.</p>`;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries
    .map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><span class="track"><i style="width:${((v / max) * 100).toFixed(1)}%"></i></span><span class="num">${esc(fmt(v))}</span></div>`)
    .join("");
}

const CSS = `
:root{color-scheme:dark;--bg:#0c0a14;--panel:#151122;--line:#2a2340;--text:#ece8f6;--dim:#a39cba;--ok:#7dffb0;--bad:#ff9a9a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:18px;padding:12px 24px;border-bottom:1px solid var(--line);background:#100c1c;position:sticky;top:0;z-index:1}
.mark{font-weight:800;letter-spacing:.2em;background:linear-gradient(180deg,#fff,#ffd8a8 55%,#ff7edb);-webkit-background-clip:text;background-clip:text;color:transparent}
nav a{color:var(--dim);text-decoration:none;margin-right:14px}nav a.on{color:var(--text);font-weight:600}
header .who{margin-left:auto;color:var(--dim);font-size:13px}
main{max-width:1120px;margin:0 auto;padding:12px 24px 64px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:16px 0;overflow-x:auto}
h2{font-size:14px;margin:0 0 10px;letter-spacing:.04em;text-transform:uppercase;color:#d9d3ea}
h3{font-size:13px;margin:14px 0 6px;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;border-top:none;white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--dim)}
.chip{display:inline-block;padding:0 7px;border-radius:999px;font-size:11px;border:1px solid var(--line);color:var(--dim);margin-left:4px}
.chip.admin{border-color:#ffb86b88;color:#ffd8a8}.chip.bad{border-color:#ff9a9a66;color:var(--bad)}
form.inline{display:inline-flex;gap:6px;align-items:center;margin:0 6px 4px 0}
button{font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:#1d1730;color:var(--text);cursor:pointer}
button:hover{border-color:#5a4a86}button.danger{border-color:#ff9a9a55;color:#ffc0c0}
input[type=text]{font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:#100c1c;color:var(--text);min-width:260px}
label.confirm{font-size:11px;color:var(--dim);display:inline-flex;gap:3px;align-items:center}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.kpi span{color:var(--dim);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 16px}
.bar{display:grid;grid-template-columns:minmax(80px,140px) 1fr 70px;gap:10px;align-items:center;margin:5px 0;font-size:13px}
.track{display:block;height:10px;border-radius:5px;background:#0f0b1a}
.track i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#36f9f6,#b48cff)}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9d3ea}
.flash{border-color:#7dffb055;color:var(--ok)}
`;

export function page(opts: { title: string; active: "admin" | "stats"; who: string; body: string; flash?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(opts.title)} · FIRSTLIGHT</title><style>${CSS}</style></head>
<body><header><span class="mark">FIRSTLIGHT</span><nav><a href="/admin"${opts.active === "admin" ? ' class="on"' : ""}>Admin</a><a href="/stats"${opts.active === "stats" ? ' class="on"' : ""}>Stats</a></nav><span class="who">${esc(opts.who)}</span></header>
<main>${opts.flash ? `<section class="flash">${esc(opts.flash)}</section>` : ""}${opts.body}</main></body></html>`;
}

/** Security headers for the HTML pages: no scripts, no framing, no caching. */
export const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

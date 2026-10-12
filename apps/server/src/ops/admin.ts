// /admin (SPEC §6.11): reports (paged; dismiss, ban), bans (lift), players online per room (kick, ban,
// voice-mute), announcements and recent server errors. Server-rendered HTML, no scripts, admin
// session required (requireAdmin). The client domain proxies /admin/* so the session cookie works.
//
// POST actions are plain HTML forms; they must carry an Origin from the allow-list (CSRF guard on
// top of the session cookie's SameSite=Lax), and redirect back with 303.

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Identity } from "../auth/identity.ts";
import { deleteReport, getAccount, liftBan, listBans, listReports, type Db } from "../db/index.ts";
import { stmt } from "../db/game-db.ts";
import { announceAll, banAccount, isVoiceMuted, kickUser, liveRooms, presenceOf, setVoiceMuted } from "../social/index.ts";
import { clearBannedUntilIfFree } from "../social/store.ts";
import { PF } from "@firstlight/shared/net/schema";
import { installErrorCapture, recentErrors } from "./errors.ts";
import { bars, esc, fmtDuration, fmtTime, page, PAGE_HEADERS } from "./html.ts";
import { mountStats } from "./stats.ts";

export interface OpsDeps {
  db: Db;
  requireAdmin: RequestHandler | ((req: Request, res: Response, next: NextFunction) => Promise<void>);
  /** Origins allowed to POST admin forms (the client origin). */
  allowedOrigins: string[];
}

/** Mount /admin and /stats (call after express.json()). */
export function mountOps(app: Express, deps: OpsDeps): void {
  installErrorCapture();
  const gate = deps.requireAdmin as RequestHandler;
  const form = express.urlencoded({ extended: false, limit: "8kb" });
  const allowed = new Set(deps.allowedOrigins);
  const sameOrigin: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const ok = typeof origin === "string" && (allowed.has(origin) || (typeof host === "string" && (origin === `https://${host}` || origin === `http://${host}`)));
    if (!ok) {
      res.status(403).type("text/plain").send("Cross-site form posts are refused.");
      return;
    }
    next();
  };
  const back = (res: Response, flash: string) => res.redirect(303, `/admin?done=${encodeURIComponent(flash)}`);
  const admin = (res: Response) => res.locals.identity as Identity;

  app.get("/admin", gate, (req, res) => {
    const flash = typeof req.query.done === "string" ? req.query.done.slice(0, 120) : undefined;
    const reportsPage = Math.max(1, Math.floor(Number(req.query.reports)) || 1);
    res.set(PAGE_HEADERS).send(page({ title: "Admin", active: "admin", who: `Signed in as ${admin(res).name}`, flash, body: adminBody(deps.db, reportsPage) }));
  });

  app.post("/admin/announce", gate, sameOrigin, form, (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const n = announceAll(text);
    back(res, text.trim() ? `Announced to ${n} player(s).` : "Nothing to announce.");
  });

  app.post("/admin/reports/:id/dismiss", gate, sameOrigin, form, (req, res) => {
    deleteReport(deps.db, Number(req.params.id));
    back(res, "Report dismissed.");
  });

  app.post("/admin/reports/:id/ban", gate, sameOrigin, form, (req, res) => {
    if (req.body?.confirm !== "on") return back(res, "Tick “sure” to ban.");
    const r = stmt(deps.db, "SELECT target, reason FROM report WHERE id = ?").get(Number(req.params.id)) as { target: string; reason: string } | undefined;
    if (!r) return back(res, "That report is gone.");
    banAccount(r.target, `report #${req.params.id}: ${r.reason}`.slice(0, 200), admin(res).userId);
    deleteReport(deps.db, Number(req.params.id));
    back(res, `Banned ${nameOf(deps.db, r.target)} (account and network).`);
  });

  app.post("/admin/bans/:id/lift", gate, sameOrigin, form, (req, res) => {
    const row = stmt(deps.db, "SELECT user_id FROM ban WHERE id = ?").get(Number(req.params.id)) as { user_id: string | null } | undefined;
    const lifted = liftBan(deps.db, Number(req.params.id));
    if (row?.user_id) clearBannedUntilIfFree(deps.db, row.user_id);
    back(res, lifted ? "Ban lifted." : "That ban is gone.");
  });

  app.post("/admin/players/:userId/:action", gate, sameOrigin, form, (req, res) => {
    const userId = String(req.params.userId);
    const name = nameOf(deps.db, userId);
    switch (req.params.action) {
      case "kick":
        kickUser(userId, "Removed by an admin");
        return back(res, `Kicked ${name}.`);
      case "ban":
        if (req.body?.confirm !== "on") return back(res, "Tick “sure” to ban.");
        banAccount(userId, typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "banned from /admin", admin(res).userId);
        return back(res, `Banned ${name} (account and network).`);
      case "voicemute": {
        const on = !isVoiceMuted(userId);
        setVoiceMuted(userId, on);
        return back(res, `${name}: voice ${on ? "muted" : "unmuted"}.`);
      }
      default:
        res.status(404).type("text/plain").send("Unknown action.");
    }
  });

  mountStats(app, deps);
}

function nameOf(db: Db, userId: string): string {
  return getAccount(db, userId)?.displayName ?? presenceOf(userId)?.name ?? userId.slice(0, 10);
}

/** Reports per /admin page; older ones are reached with ?reports=<page> (a flood can't hide them). */
const REPORTS_PER_PAGE = 50;

function adminBody(db: Db, reportsPage = 1): string {
  const now = Date.now();
  // ---- players online per room
  const rooms = [...liveRooms].sort((a, b) => a.bodyDef.id.localeCompare(b.bodyDef.id) || a.state.copy - b.state.copy);
  const total = rooms.reduce((n, r) => n + (r.metadata?.loadtest ? 0 : r.actors.size), 0);
  const roomRows = rooms
    .map((r) => {
      const players = [...r.actors.values()]
        .sort((a, b) => a.identity.name.localeCompare(b.identity.name))
        .map((a) => {
          const u = esc(encodeURIComponent(a.identity.userId));
          const chips = [
            a.identity.admin ? `<span class="chip admin">admin</span>` : "",
            a.identity.guest ? `<span class="chip">guest</span>` : "",
            a.identity.loadtest ? `<span class="chip">bot</span>` : "",
            a.state.flags & PF.VOICE_MUTED ? `<span class="chip bad">voice-muted</span>` : "",
            a.dead ? `<span class="chip bad">dead</span>` : "",
            a.state.party ? `<span class="chip">party</span>` : "",
          ].join("");
          return `<tr><td>${esc(a.identity.name)}${chips}<div class="muted">${esc(a.identity.userId)}</div></td><td class="num">${a.state.level}</td><td class="num">${fmtDuration(now - a.joinedAt)}</td>
<td><form class="inline" method="post" action="/admin/players/${u}/kick"><button>Kick</button></form>
<form class="inline" method="post" action="/admin/players/${u}/voicemute"><button>${a.state.flags & PF.VOICE_MUTED ? "Unmute voice" : "Mute voice"}</button></form>
<form class="inline" method="post" action="/admin/players/${u}/ban"><label class="confirm"><input type="checkbox" name="confirm" required>sure</label><button class="danger">Ban</button></form></td></tr>`;
        })
        .join("");
      const label = `${r.bodyDef.name} · copy ${r.state.copy + 1}${r.metadata?.loadtest ? " · load test" : ""}`;
      return `<h3>${esc(label)} <span class="muted">· ${r.actors.size} online${r.lingering.size ? `, ${r.lingering.size} lingering` : ""} · ${esc(r.roomId)}</span></h3>
${players ? `<table><tr><th>Player</th><th class="num">Level</th><th class="num">Here for</th><th>Actions</th></tr>${players}</table>` : `<p class="muted">Empty.</p>`}`;
    })
    .join("");

  // ---- reports (paged, newest first)
  const reportTotal = (stmt(db, "SELECT COUNT(*) AS n FROM report").get() as { n: number }).n;
  const reportPages = Math.max(1, Math.ceil(reportTotal / REPORTS_PER_PAGE));
  const rp = Math.min(reportsPage, reportPages);
  const reports = listReports(db, REPORTS_PER_PAGE, (rp - 1) * REPORTS_PER_PAGE);
  const pageLink = (n: number, label: string) => `<a href="/admin?reports=${n}#reports">${label}</a>`;
  const pager =
    reportPages > 1
      ? `<p class="muted">Page ${rp} of ${reportPages}, newest first. ${rp > 1 ? pageLink(rp - 1, "← Newer") : ""} ${rp < reportPages ? pageLink(rp + 1, "Older →") : ""}</p>`
      : "";
  const reportRows = reports
    .map(
      (r) => `<tr><td class="num">${fmtTime(r.createdAt)}</td><td>${esc(nameOf(db, r.reporter))}</td><td>${esc(nameOf(db, r.target))}<div class="muted">${esc(r.target)}</div></td>
<td>${esc(r.body ?? "—")}${r.pos ? `<div class="muted">${r.pos.map((v) => v.toFixed(0)).join(", ")}</div>` : ""}</td><td>${esc(r.reason)}</td>
<td><form class="inline" method="post" action="/admin/reports/${r.id}/dismiss"><button>Dismiss</button></form>
<form class="inline" method="post" action="/admin/reports/${r.id}/ban"><label class="confirm"><input type="checkbox" name="confirm" required>sure</label><button class="danger">Ban</button></form></td></tr>`,
    )
    .join("");

  // ---- bans
  const bans = listBans(db, now);
  const banRows = bans
    .map(
      (b) => `<tr><td class="num">${fmtTime(b.createdAt)}</td><td>${b.userId ? `${esc(nameOf(db, b.userId))}<div class="muted">${esc(b.userId)}</div>` : `<span class="muted">network only</span>`}</td>
<td>${b.ipHash ? "yes" : "no"}</td><td>${esc(b.reason)}</td><td>${b.createdBy ? esc(nameOf(db, b.createdBy)) : "—"}</td><td>${b.until ? fmtTime(b.until) : "permanent"}</td>
<td><form class="inline" method="post" action="/admin/bans/${b.id}/lift"><button>Lift</button></form></td></tr>`,
    )
    .join("");

  // ---- errors
  const errors = recentErrors();
  const errorRows = errors.map((e) => `<tr><td class="num">${fmtTime(e.at)}</td><td>${esc(e.source)}${e.count > 1 ? ` ×${e.count}` : ""}</td><td><pre>${esc(e.message)}</pre></td></tr>`).join("");

  const perBody = new Map<string, number>();
  for (const r of rooms) if (!r.metadata?.loadtest) perBody.set(r.bodyDef.name, (perBody.get(r.bodyDef.name) ?? 0) + r.actors.size);

  return `
<div class="kpis"><div class="kpi"><b>${total}</b><span>players online</span></div><div class="kpi"><b>${reportTotal}</b><span>open reports</span></div><div class="kpi"><b>${bans.length}</b><span>active bans</span></div><div class="kpi"><b>${errors.length}</b><span>recent errors</span></div></div>
<section><h2>Announce</h2><form class="inline" method="post" action="/admin/announce"><input type="text" name="text" maxlength="200" placeholder="Banner text for every player" required><button>Send to everyone</button></form></section>
<section><h2>Players online</h2>${bars([...perBody.entries()])}${roomRows || `<p class="muted">No rooms are open.</p>`}</section>
<section id="reports"><h2>Reports</h2>${pager}${reportRows ? `<table><tr><th>When</th><th>By</th><th>Player</th><th>Where</th><th>Reason</th><th>Actions</th></tr>${reportRows}</table>${pager}` : `<p class="muted">No reports.</p>`}</section>
<section><h2>Bans</h2>${banRows ? `<table><tr><th>When</th><th>Account</th><th>Network</th><th>Reason</th><th>By</th><th>Until</th><th></th></tr>${banRows}</table>` : `<p class="muted">No active bans.</p>`}</section>
<section><h2>Recent server errors</h2>${errorRows ? `<table><tr><th>When</th><th>Source</th><th>Message</th></tr>${errorRows}</table>` : `<p class="muted">None since the last restart.</p>`}</section>`;
}

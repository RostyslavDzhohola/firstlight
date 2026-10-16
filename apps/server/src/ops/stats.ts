// /stats (SPEC §6.11): sessions today and over 7 days, playtime distribution, deaths, levels,
// renderer backend and tier split, time per body, D1/D7 return, players online now. Our own data
// only (session_log in game.db); load-test players are never recorded, and our test accounts are
// left out of every figure and counted apart (D-home-6). `?format=json` for scripts.

import type { Express, RequestHandler } from "express";
import type { Identity } from "../auth/identity.ts";
import { retention, sessionStats, testSessionCount } from "../db/index.ts";
import { liveRooms } from "../social/index.ts";
import { bars, esc, fmtDuration, page, PAGE_HEADERS, pct } from "./html.ts";
import type { OpsDeps } from "./admin.ts";

const DAY = 86_400_000;
const BODY_NAMES: Record<string, string> = { portus: "Portus", arcadia: "Arcadia", hollowmere: "Hollowmere", meridian: "Meridian" };

/** Real players online now, per body; our test accounts are counted apart (D-home-6). */
function onlineNow(): { total: number; perBody: Record<string, number>; test: number } {
  const perBody: Record<string, number> = {};
  let total = 0;
  let test = 0;
  for (const r of liveRooms) {
    if (r.metadata?.loadtest || r.metadata?.sandbox) continue; // admin sandboxes aren't play (D-admin-3)
    let n = 0;
    for (const a of r.actors.values()) {
      if (a.identity.loadtest) continue;
      if (a.identity.test) test++;
      else n++;
    }
    perBody[r.bodyDef.id] = (perBody[r.bodyDef.id] ?? 0) + n;
    total += n;
  }
  return { total, perBody, test };
}

export function mountStats(app: Express, deps: OpsDeps): void {
  const gate = deps.requireAdmin as RequestHandler;
  app.get("/stats", gate, (req, res) => {
    const now = Date.now();
    const today = sessionStats(deps.db, Math.floor(now / DAY) * DAY);
    const week = sessionStats(deps.db, now - 7 * DAY);
    const ret = retention(deps.db, now);
    const online = onlineNow();
    const tests = testSessionCount(deps.db, now - 7 * DAY);
    if (req.query.format === "json") {
      res.set("Cache-Control", "no-store").json({ online, today, week, retention: ret, testAccounts: { onlineNow: online.test, week: tests } });
      return;
    }
    const who = (res.locals.identity as Identity).name;
    const levelEntries = Object.entries(week.maxLevel).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [`level ${k}`, v] as [string, number]);
    const split = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);
    const ended = Object.values(week.playtime).reduce((a, b) => a + b, 0);
    const cohortRows = ret.cohorts
      .slice(-14)
      .reverse()
      .map((c) => `<tr><td>${esc(c.day)}</td><td class="num">${c.cohort}</td><td class="num">${c.d1 === null ? "—" : `${c.d1} (${pct(c.d1 / c.cohort)})`}</td><td class="num">${c.d7 === null ? "—" : `${c.d7} (${pct(c.d7 / c.cohort)})`}</td></tr>`)
      .join("");
    const body = `
<div class="kpis">
<div class="kpi"><b>${online.total}</b><span>online now</span></div>
<div class="kpi"><b>${today.sessions}</b><span>sessions today (${today.players} players)</span></div>
<div class="kpi"><b>${week.sessions}</b><span>sessions in 7 days (${week.players} players)</span></div>
<div class="kpi"><b>${fmtDuration(week.medianSessionMs)}</b><span>median session (7 d)</span></div>
<div class="kpi"><b>${fmtDuration(week.totalPlayMs)}</b><span>total playtime (7 d)</span></div>
<div class="kpi"><b>${week.deaths}</b><span>deaths (7 d)</span></div>
<div class="kpi"><b>${pct(ret.d1Rate)}</b><span>D1 return (30 d cohorts)</span></div>
<div class="kpi"><b>${pct(ret.d7Rate)}</b><span>D7 return (30 d cohorts)</span></div>
</div>
<div class="grid2">
<section><h2>Session length (7 d, ${ended} ended)</h2>${bars(Object.entries(week.playtime))}</section>
<section><h2>Highest level per session (7 d)</h2>${bars(levelEntries)}</section>
<section><h2>Renderer backend (7 d)</h2>${bars(split(week.backend))}</section>
<section><h2>Quality tier (7 d)</h2>${bars(split(week.tier))}</section>
<section><h2>Time per body (7 d)</h2>${bars(split(week.bodyTimeMs).map(([k, v]) => [BODY_NAMES[k] ?? k, v]), fmtDuration)}</section>
<section><h2>Online now by body</h2>${bars(Object.entries(online.perBody).map(([k, v]) => [BODY_NAMES[k] ?? k, v]))}</section>
</div>
<section><h2>Return rate by first-play day</h2>${cohortRows ? `<table><tr><th>First played</th><th class="num">Players</th><th class="num">Back next day</th><th class="num">Back on day 7</th></tr>${cohortRows}</table>` : `<p class="muted">No sessions yet.</p>`}
<p class="muted">Every figure here is real players only. Our test accounts (D-home-6): ${online.test} online now, ${tests.sessions} session(s) by ${tests.players} account(s) in 7 days.</p>
<p class="muted">Days are UTC. Today: ${today.open} session(s) still open, ${fmtDuration(today.totalPlayMs)} played in ended sessions, ${today.deaths} death(s).</p></section>`;
    res.set(PAGE_HEADERS).send(page({ title: "Stats", active: "stats", who: `Signed in as ${who}`, body }));
  });
}

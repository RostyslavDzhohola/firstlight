// /stats (SPEC §6.11): sessions today and over 7 days, playtime distribution, deaths, levels,
// renderer backend and tier split, time per body, D1/D7 return, players online now. Our own data
// only (session_log in game.db); load-test players are never recorded, and our test accounts are
// left out of every figure and counted apart (D-home-6). The #85 funnel and client errors (db/funnel.ts)
// lead the page. `?format=json` for scripts (`pnpm metrics --funnel` reads it).

import type { Express, RequestHandler } from "express";
import type { Identity } from "../auth/identity.ts";
import {
  ACCOUNT_FUNNEL,
  agentSessionCount,
  funnelWindows,
  retention,
  sessionStats,
  testSessionCount,
  VISIT_FUNNEL,
  type FunnelKpi,
  type FunnelReport,
} from "../db/index.ts";
import { liveRooms } from "../social/index.ts";
import { bars, esc, fmtDuration, fmtTime, page, PAGE_HEADERS, pct } from "./html.ts";
import type { OpsDeps } from "./admin.ts";

const DAY = 86_400_000;
const BODY_NAMES: Record<string, string> = { portus: "Portus", arcadia: "Arcadia", hollowmere: "Hollowmere", meridian: "Meridian" };

/** Real players online now, per body; our test accounts are counted apart (D-home-6). */
function onlineNow(): { total: number; perBody: Record<string, number>; test: number; agents: number } {
  const perBody: Record<string, number> = {};
  let total = 0;
  let test = 0;
  let agents = 0;
  for (const r of liveRooms) {
    if (r.metadata?.loadtest || r.metadata?.sandbox) continue; // admin sandboxes aren't play (D-admin-3)
    let n = 0;
    for (const a of r.actors.values()) {
      if (a.identity.loadtest) continue;
      if (a.identity.test) test++;
      else if (a.identity.agent) agents++; // AI agents (D-agents-1): counted apart from people
      else n++;
    }
    perBody[r.bodyDef.id] = (perBody[r.bodyDef.id] ?? 0) + n;
    total += n;
  }
  return { total, perBody, test, agents };
}

const STEP_NAMES: Record<string, string> = {
  page: "Opened the page",
  play: "Pressed Play",
  pick: "Picked a character",
  world: "World on screen",
  tutorial_done: "Finished the tutorial",
  join: "Joined a world",
  kill: "First kill",
  mission: "First mission taken",
  level2: "Level 2",
  level5: "Level 5",
  saved: "Saved the character",
  first_session: "First session ended",
  back: "Came back on a later day",
};

function kpiCell(k: FunnelKpi): string {
  if (k.value === null) return `<td class="num muted">—</td>`;
  const shown = k.unit === "share" ? `${pct(k.value)} <span class="muted">(${k.num}/${k.den})</span>` : k.unit === "s" ? `${k.value.toFixed(1)} s` : fmtDuration(k.value);
  return `<td class="num"${k.ok === false ? ' style="color:var(--bad)"' : k.ok ? ' style="color:var(--ok)"' : ""}>${shown}</td>`;
}

function stepRows(steps: readonly string[], pick: (r: FunnelReport) => Record<string, number>, w: { day: FunnelReport; week: FunnelReport; all: FunnelReport }): string {
  const cell = (r: FunnelReport, step: string) => {
    const m = pick(r);
    const first = m[steps[0]!] ?? 0;
    const n = m[step] ?? 0;
    return `<td class="num">${n}${first && step !== steps[0] ? ` <span class="muted">(${pct(n / first)})</span>` : ""}</td>`;
  };
  return steps.map((s) => `<tr><td>${esc(STEP_NAMES[s] ?? s)}</td>${cell(w.day, s)}${cell(w.week, s)}${cell(w.all, s)}</tr>`).join("");
}

function funnelSection(f: ReturnType<typeof funnelWindows>): string {
  const w = f.windows;
  const kpiRows = f.kpis.all.map((k, i) => `<tr><td>${esc(k.label)}</td><td class="muted">${esc(k.target)}</td>${kpiCell(f.kpis.day[i]!)}${kpiCell(f.kpis.week[i]!)}${kpiCell(k)}</tr>`).join("");
  const head = `<tr><th></th><th class="num">Last day</th><th class="num">7 days</th><th class="num">All time</th></tr>`;
  const tutorialSteps = w.all.tutorial.map((t) => `tutorial:${t.step}`);
  const tutorialRows = tutorialSteps.length
    ? stepRows(["world", ...tutorialSteps, "tutorial_done"], (r) => r.visits, w).replace(/<td>tutorial:([^<]*)<\/td>/g, "<td>Tutorial: $1</td>")
    : "";
  const errorRows = f.errors.week.kinds
    .map((e) => `<tr><td class="num">${e.count}</td><td><b>${esc(e.message)}</b><pre>${esc(e.stack.split("\n").slice(0, 2).join("\n"))}</pre></td><td class="muted">${esc(e.where)}<br>build ${esc(e.build)}</td><td class="muted">${esc(fmtTime(e.lastAt))}</td></tr>`)
    .join("");
  const split = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);
  return `
<section><h2>Launch KPIs (#85): new visits and characters</h2>
<table><tr><th>KPI</th><th>Target</th><th class="num">Last day</th><th class="num">7 days</th><th class="num">All time</th></tr>${kpiRows}</table>
<p class="muted">A window holds the visits and characters whose first step falls in it. People only: our test visits and accounts (${w.all.apart.test}) and AI agents (${w.all.apart.agent}) are counted apart. Characters that played before the funnel existed are not counted.</p></section>
<div class="grid2">
<section><h2>First visit, step by step</h2><table>${head}${stepRows(VISIT_FUNNEL, (r) => r.visits, w)}</table></section>
<section><h2>New characters, step by step</h2><table>${head}${stepRows(ACCOUNT_FUNNEL, (r) => r.accounts, w)}</table></section>
</div>
${tutorialRows ? `<section><h2>Tutorial, step by step (visits)</h2><table>${head}${tutorialRows}</table></section>` : ""}
<div class="grid2">
<section><h2>Renderer the first visit picked (7 d)</h2>${bars(split(w.week.backend))}<h3>Quality tier</h3>${bars(split(w.week.tier))}</section>
<section><h2>Graphics fallbacks and failure screens (7 d)</h2>${bars([...split(w.week.fallback).map(([k, v]) => [`WebGL2: ${k}`, v] as [string, number]), ...(["boot_fail", "lost", "webgl_none", "removed", "version"] as const).filter((k) => w.week.visits[k]).map((k) => [k.replace("_", " "), w.week.visits[k]!] as [string, number])])}</section>
</div>
<section><h2>Client errors (7 d): ${f.errors.week.total} report(s)</h2>${errorRows ? `<table><tr><th class="num">Reports</th><th>Error</th><th>Where</th><th>Last</th></tr>${errorRows}</table>` : `<p class="muted">No client errors reported.</p>`}
<p class="muted">Each page reports a kind of error once per session. Last day: ${f.errors.day.total}, all time (90 d kept): ${f.errors.all.total}. From test visits and agents, apart: ${f.errors.week.apart}.</p></section>`;
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
    const agentWeek = agentSessionCount(deps.db, now - 7 * DAY);
    const funnel = funnelWindows(deps.db, now);
    if (req.query.format === "json") {
      res.set("Cache-Control", "no-store").json({ online, today, week, retention: ret, testAccounts: { onlineNow: online.test, week: tests }, agents: { onlineNow: online.agents, week: agentWeek }, funnel });
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
${funnelSection(funnel)}
<div class="grid2">
<section><h2>Session length (7 d, ${ended} ended)</h2>${bars(Object.entries(week.playtime))}</section>
<section><h2>Highest level per session (7 d)</h2>${bars(levelEntries)}</section>
<section><h2>Renderer backend (7 d)</h2>${bars(split(week.backend))}</section>
<section><h2>Quality tier (7 d)</h2>${bars(split(week.tier))}</section>
<section><h2>Time per body (7 d)</h2>${bars(split(week.bodyTimeMs).map(([k, v]) => [BODY_NAMES[k] ?? k, v]), fmtDuration)}</section>
<section><h2>Online now by body</h2>${bars(Object.entries(online.perBody).map(([k, v]) => [BODY_NAMES[k] ?? k, v]))}</section>
</div>
<section><h2>Return rate by first-play day</h2>${cohortRows ? `<table><tr><th>First played</th><th class="num">Players</th><th class="num">Back next day</th><th class="num">Back on day 7</th></tr>${cohortRows}</table>` : `<p class="muted">No sessions yet.</p>`}
<p class="muted">Every figure here is real players only. Our test accounts (D-home-6): ${online.test} online now, ${tests.sessions} session(s) by ${tests.players} account(s) in 7 days. AI agents (D-agents-1): ${online.agents} online now, ${agentWeek.sessions} session(s) by ${agentWeek.players} account(s) in 7 days.</p>
<p class="muted">Days are UTC. Today: ${today.open} session(s) still open, ${fmtDuration(today.totalPlayMs)} played in ended sessions, ${today.deaths} death(s).</p></section>`;
    res.set(PAGE_HEADERS).send(page({ title: "Stats", active: "stats", who: `Signed in as ${who}`, body }));
  });
}

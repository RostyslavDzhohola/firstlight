// Account HTTP routes (mounted after express.json()):
//   GET  /api/account/me         Bearer JWT → account summary (display name, guest, admin, character, medals, pads)
//   POST /api/account/name       Bearer JWT, {name} → set the display name (unique, filtered)
//   GET  /api/account/save-status  public → {saving: "ok" | "busy" | "unavailable"}: can sign-in codes go out?
//   GET  /admin/claim            a form → POST /admin/claim {token}: this browser's account (guest or
//                                saved) becomes admin, the token burns (POST only, rate-limited; D-admin-2)
//   POST /api/test/bot-token     x-loadtest-secret → a loadtest play token (only when LOADTEST_SECRET is set)

import { randomUUID } from "node:crypto";
import { STARTERS, starterLook } from "@firstlight/shared/content/weapons";
import { fromNodeHeaders } from "better-auth/node";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { claimAdmin, ensureAccount, getAccount, isBanned, isClaimBurnt, setDisplayName } from "../db/accounts.ts";
import { listDiscoveredPads, listMedals, loadCharacter } from "../db/characters.ts";
import { NAME_MESSAGES } from "../db/names.ts";
import type { Accounts, AccountsConfig } from "./accounts.ts";
import { safeEqual, sha256Hex } from "./crypto.ts";
import type { Identity } from "./identity.ts";
import { directRequestIp, firstForwardedFor } from "./ip.ts";

/** mission_state_json → `life.playMs` (0 for older rows without per-life progress). */
function lifePlayMs(ms: unknown): number {
  const v = (ms as { life?: { playMs?: unknown } | null } | null)?.life?.playMs;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function bearerToken(req: Request): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function bearerIdentity(a: Accounts, req: Request): Promise<Identity | null> {
  const token = bearerToken(req);
  const tool = req.headers["x-loadtest-secret"];
  return token ? a.verify(token, { ip: directRequestIp(req), toolSecret: typeof tool === "string" ? tool : null }) : null;
}

/** Identity from the Better Auth session cookie (requests that come through the client origin). */
export async function sessionIdentity(a: Accounts, req: Request): Promise<Identity | null> {
  if (!req.headers.cookie) return null;
  const s = await a.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!s?.user) return null;
  const now = Date.now();
  if (isBanned(a.db, s.user.id, now)) return null;
  const acc = ensureAccount(a.db, s.user.id, now);
  return { userId: s.user.id, name: acc.displayName ?? s.user.name, guest: !!s.user.isAnonymous, admin: acc.isAdmin, loadtest: false };
}

export async function identifyRequest(a: Accounts, req: Request): Promise<Identity | null> {
  return (await sessionIdentity(a, req)) ?? (await bearerIdentity(a, req));
}

export function requireAdminFor(a: Accounts) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = await identifyRequest(a, req);
    if (!id || id.loadtest) {
      res.status(401).json({ ok: false, error: "sign in first" });
      return;
    }
    if (!id.admin) {
      res.status(403).json({ ok: false, error: "admins only" });
      return;
    }
    res.locals.identity = id;
    next();
  };
}

const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export function mountAccountRoutes(app: Express, a: Accounts, cfg: AccountsConfig): void {
  app.get("/api/account/me", noStore, async (req, res) => {
    const id = await bearerIdentity(a, req);
    if (!id) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const acc = id.loadtest ? null : getAccount(a.db, id.userId);
    const c = id.loadtest ? null : loadCharacter(a.db, id.userId);
    res.json({
      ok: true,
      userId: id.userId,
      name: id.name,
      displayName: acc?.displayName ?? null,
      guest: id.guest,
      admin: id.admin,
      titleMedal: acc?.titleMedal ?? null,
      // `starter` is the index the game uses everywhere (PlayerState.starter, fl.starter), not the stored
      // id: a second browser signing in stores it as fl.starter (HANDOFF 5b). Same mapping as the rooms.
      character: c ? characterInfo(c) : null,
      // A guest the server will email a code for a new address (D34: from level 2), i.e. who can save now.
      saveReady: !id.loadtest && id.guest && a.maySave(id.userId),
      /** Online time in this life (the Old Timer clock), for the home page's progress card. */
      playMs: lifePlayMs(c?.missionState),
      medals: id.loadtest ? [] : listMedals(a.db, id.userId).map((m) => m.medalId),
      pads: id.loadtest ? [] : listDiscoveredPads(a.db, id.userId),
    });
  });

  // The save card and the sign-in card ask before the player types an address (HANDOFF 5c).
  app.get("/api/account/save-status", noStore, (_req, res) => {
    res.json({ ok: true, saving: a.mailHealth.state() });
  });

  app.post("/api/account/name", noStore, async (req, res) => {
    const id = await bearerIdentity(a, req);
    if (!id || id.loadtest) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const raw = typeof req.body?.name === "string" ? req.body.name : "";
    const r = setDisplayName(a.db, id.userId, raw);
    if (!r.ok) {
      res.status(r.error === "taken" ? 409 : 400).json({ ok: false, error: r.error, message: NAME_MESSAGES[r.error] });
      return;
    }
    // Keep the auth user's name in step: it is the JWT `name` and the name carried over on save.
    const ctx = await a.auth.$context;
    if (await ctx.internalAdapter.findUserById(id.userId)) await ctx.internalAdapter.updateUser(id.userId, { name: r.name });
    res.json({ ok: true, name: r.name });
  });

  // One-time admin claim with the server's ADMIN_CLAIM_TOKEN, for the account playing in this browser
  // (its session cookie, so it runs on the game origin through the proxy), guest or saved: the owner
  // can't save with an email until mail works, and admins are never pruned as guests (prune.ts).
  // POST only (D-admin-2): the code never rides in a URL; the request must come from the game's
  // origin (and through the proxy, when an origin secret is set); attempts are limited per client IP
  // and overall before any comparison; and a short token switches the claim off.
  const claimToken = claimTokenStrong(cfg.adminClaimToken) ? cfg.adminClaimToken : "";
  if (cfg.adminClaimToken && !claimToken) console.warn("[admin] ADMIN_CLAIM_TOKEN is too short (use 32 random bytes, e.g. `openssl rand -base64 32`): the admin claim is off");
  const attempts = new ClaimLimiter();
  const claimHeaders = (res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    // No Referer leaves the site (the code never rides in a URL). Not "no-referrer": with it the
    // browser sends `Origin: null` on the form's own POST, and the origin check below needs the origin.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  };

  app.get("/admin/claim", (_req, res) => {
    claimHeaders(res);
    if (!claimToken) {
      res.status(404).type("text/plain").send("Not found.");
      return;
    }
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>FIRSTLIGHT admin claim</title><body style="font:16px system-ui;max-width:32em;margin:3em auto;padding:0 1em">
<h1 style="font-size:1.3em">Make this account an admin</h1>
<p>Open this page in the browser you play in (the account playing there becomes the admin), paste the claim code and press Claim. The code works once.</p>
<form method="post" action="/admin/claim"><input name="token" type="password" autocomplete="off" required style="font:inherit;width:100%;padding:.4em" placeholder="claim code">
<p><button style="font:inherit;padding:.4em 1.2em">Claim</button></p></form></body>`);
  });

  app.post("/admin/claim", express.urlencoded({ extended: false, limit: "2kb" }), async (req, res) => {
    claimHeaders(res);
    res.type("text/plain");
    if (!claimToken) {
      res.status(404).send("Not found.");
      return;
    }
    // Through the game origin's proxy (it adds the origin secret), from the game's own page.
    if (cfg.originSecret) {
      const got = req.headers["x-origin-secret"];
      if (typeof got !== "string" || !safeEqual(got, cfg.originSecret)) {
        res.status(403).send("Open this page on the game's site.");
        return;
      }
    }
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !cfg.trustedOrigins.includes(origin)) {
      res.status(403).send("Open this page on the game's site.");
      return;
    }
    const ip = (cfg.originSecret ? firstForwardedFor(req) : directRequestIp(req)) ?? "unknown";
    if (!attempts.take(ip, Date.now())) {
      res.status(429).send("Too many attempts. Try again later.");
      return;
    }
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token || !safeEqual(token, claimToken)) {
      res.status(403).send("That claim code isn't valid.");
      return;
    }
    const tokenHash = sha256Hex(token);
    if (isClaimBurnt(a.db, tokenHash)) {
      res.status(410).send("This claim code was already used.");
      return;
    }
    const id = await identifyRequest(a, req);
    if (!id || id.loadtest) {
      res.status(401).send("Play once in this browser (so you're signed in), then open this page again.");
      return;
    }
    if (claimAdmin(a.db, tokenHash, id.userId) === "burnt") {
      res.status(410).send("This claim code was already used.");
      return;
    }
    console.log(`admin claimed${id.guest ? " (guest account)" : ""}`);
    res.send(
      `Done. ${id.name} is now an admin. Back in the game, rejoin (reload the page) and open the Esc menu: the Admin section is there.` +
        (id.guest ? " This is a guest character: it lives in this browser. Save it with an email when you can to keep it anywhere." : ""),
    );
  });

  app.post("/api/test/bot-token", noStore, async (req, res) => {
    if (!cfg.loadtestSecret) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    const got = req.headers["x-loadtest-secret"];
    if (typeof got !== "string" || !safeEqual(got, cfg.loadtestSecret)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const raw = typeof req.body?.id === "string" ? req.body.id : "";
    const id = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || randomUUID().replace(/-/g, "").slice(0, 12);
    const userId = `lt_${id}`;
    const name = `Bot_${id.slice(0, 8)}`;
    const { token } = await a.auth.api.signJWT({ body: { payload: { sub: userId, name, guest: true, loadtest: true } } });
    res.json({ ok: true, token, userId, name });
  });
}

/** A claim token worth honouring: at least 32 random bytes' worth (43 base64 / 64 hex characters, ~256 bits). */
export function claimTokenStrong(token: string): boolean {
  return token.length >= 43 && new Set(token).size >= 12;
}

/** Admin-claim attempts: per client IP and overall, counted before any comparison (D-admin-2). */
export class ClaimLimiter {
  static readonly PER_IP = 5;
  static readonly PER_IP_WINDOW_MS = 10 * 60_000;
  static readonly GLOBAL = 30;
  static readonly GLOBAL_WINDOW_MS = 60 * 60_000;
  private readonly byIp = new Map<string, number[]>();
  private all: number[] = [];

  take(ip: string, now: number): boolean {
    this.all = this.all.filter((t) => now - t < ClaimLimiter.GLOBAL_WINDOW_MS);
    const mine = (this.byIp.get(ip) ?? []).filter((t) => now - t < ClaimLimiter.PER_IP_WINDOW_MS);
    if (this.all.length >= ClaimLimiter.GLOBAL || mine.length >= ClaimLimiter.PER_IP) {
      this.byIp.set(ip, mine);
      return false;
    }
    mine.push(now);
    this.all.push(now);
    this.byIp.set(ip, mine);
    if (this.byIp.size > 10_000) this.byIp.clear(); // a flood of addresses: the global cap still holds
    return true;
  }
}

/** The account's live character for /api/me: indexes the game uses everywhere (PlayerState.starter,
 *  fl.starter), not the stored starter id; the look comes from the inventory record. */
function characterInfo(c: { level: number; xp: number; coins: number; starter: string; palette: number; body: string; inventory: unknown }) {
  const starter = Math.max(0, STARTERS.findIndex((s) => s.id === c.starter));
  const look = starterLook(starter, (c.inventory as { look?: unknown } | null)?.look);
  return { level: c.level, xp: c.xp, coins: c.coins, starter, palette: c.palette, look, body: c.body };
}

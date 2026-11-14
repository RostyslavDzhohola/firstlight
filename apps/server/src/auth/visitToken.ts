// Funnel visits are issued by the server (#85, D-ship-6). When the page loads it asks POST /api/visit
// for one; the answer is a signed token naming a random visit id, the visit's kind (person, test,
// agent: decided here, at issue, and never changed after) and when it was issued. The page then sends
// its steps and error reports with that token, and /api/play carries it so the room can record that
// the visit really joined a world. A step can only land on a visit the server made, and nothing the
// page sends later can move a visit into or out of the people's figures.
//
// Token: `v1.<id>.<kind letter>.<issued, base36 ms>.<mac>` with mac = HMAC-SHA256 over the rest,
// truncated to 128 bits, base64url. It accepts steps for TOKEN_TTL_MS after issue; until RENEW_MS the
// page may trade it for a fresh one with the same id and kind (a browser stays one visit for its first
// weeks), after that it is a new visit.

import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto.ts";

export type VisitKind = "person" | "test" | "agent";

export const VISIT_TOKEN = {
  /** Steps are accepted for a day after issue. */
  TOKEN_TTL_MS: 24 * 3_600_000,
  /** An expired token can be renewed (same id, same kind) for 28 days after its visit began. */
  RENEW_MS: 28 * 24 * 3_600_000,
};

const KIND_LETTER: Record<VisitKind, string> = { person: "p", test: "t", agent: "a" };
const LETTER_KIND: Record<string, VisitKind> = { p: "person", t: "test", a: "agent" };
const ID = /^[A-Za-z0-9_-]{22}$/;

let key: Buffer = randomBytes(32);

/** Sign visits with a key derived from a server secret (main.ts: the auth secret), so they survive a restart. Without it, a random key per process. */
export function setVisitKey(secret: string): void {
  key = createHmac("sha256", secret).update("firstlight funnel visit v1").digest();
}

const mac = (body: string) => createHmac("sha256", key).update(body).digest().subarray(0, 16).toString("base64url");

export interface Visit {
  id: string;
  kind: VisitKind;
  /** When the visit began (renewals keep it). */
  began: number;
  /** When this token was issued. */
  issued: number;
}

function sign(id: string, kind: VisitKind, began: number, issued: number): string {
  const body = `v1.${id}.${KIND_LETTER[kind]}.${began.toString(36)}.${issued.toString(36)}`;
  return `${body}.${mac(body)}`;
}

/** A new visit. */
export function issueVisit(kind: VisitKind, now = Date.now()): { token: string; visit: Visit } {
  const id = randomBytes(16).toString("base64url");
  return { token: sign(id, kind, now, now), visit: { id, kind, began: now, issued: now } };
}

/** A fresh token for the same visit (id, kind and start unchanged). */
export function renewVisit(v: Visit, now = Date.now()): string {
  return sign(v.id, v.kind, v.began, now);
}

/** The visit a token names if its signature holds (expiry is the caller's: see visitLive / visitRenewable). */
export function readVisit(token: unknown): Visit | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [, id, letter, b36began, b36issued, given] = parts as [string, string, string, string, string, string];
  if (!ID.test(id) || !LETTER_KIND[letter] || !/^[0-9a-z]{1,11}$/.test(b36began) || !/^[0-9a-z]{1,11}$/.test(b36issued)) return null;
  if (!safeEqual(given, mac(parts.slice(0, 5).join(".")))) return null;
  const began = parseInt(b36began, 36);
  const issued = parseInt(b36issued, 36);
  if (!(issued >= began)) return null;
  return { id, kind: LETTER_KIND[letter]!, began, issued };
}

/** Does this token still take steps? */
export function visitLive(v: Visit, now = Date.now()): boolean {
  return now >= v.issued - 60_000 && now - v.issued < VISIT_TOKEN.TOKEN_TTL_MS;
}

/** May this visit be renewed instead of starting a new one? */
export function visitRenewable(v: Visit, now = Date.now()): boolean {
  return now >= v.began - 60_000 && now - v.began < VISIT_TOKEN.RENEW_MS;
}

/** The stricter of two kinds: a visit flagged test or agent anywhere stays out of the people's figures. */
export function stricterKind(a: VisitKind, b: VisitKind): VisitKind {
  return a === "person" ? b : a;
}

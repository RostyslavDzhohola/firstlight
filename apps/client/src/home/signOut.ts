// Sign out from the home page (6a), with both of Better Auth's failure forms handled: a rejected
// request (offline, server down) and a returned `{ error }` (the server refused). Only a confirmed
// sign-out counts: if the session is still there afterwards, it failed too, so the page keeps the
// account and offers a retry instead of pretending (the next Play would reopen that account).

export interface SignOutClient {
  signOut(): Promise<unknown>;
  getSession(): Promise<unknown>;
}

export type SignOutResult = { ok: true } | { ok: false; message: string };

export const SIGN_OUT_OFFLINE = "Couldn't reach the server to sign out. You're still signed in.";
export const SIGN_OUT_REFUSED = "Signing out didn't work. You're still signed in.";

const errorOf = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: unknown }).error : null);
const dataOf = (r: unknown) => (r && typeof r === "object" && "data" in r ? (r as { data: unknown }).data : null);

export async function signOutSession(client: SignOutClient): Promise<SignOutResult> {
  try {
    if (errorOf(await client.signOut())) return { ok: false, message: SIGN_OUT_REFUSED };
  } catch {
    return { ok: false, message: SIGN_OUT_OFFLINE };
  }
  try {
    if (dataOf(await client.getSession())) return { ok: false, message: SIGN_OUT_REFUSED };
  } catch {
    // The sign-out itself was accepted; a failed check afterwards doesn't undo that.
  }
  return { ok: true };
}

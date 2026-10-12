// Play-token provider. Until Better Auth lands (M4), a dev guest id is kept in localStorage and the
// server accepts it only while ALLOW_DEV_GUESTS=1. The auth lane replaces getPlayToken().

const KEY = "firstlight.devGuest";

export async function getPlayToken(): Promise<string> {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    localStorage.setItem(KEY, id);
  }
  return `dev:${id}:Wanderer-${id.slice(0, 4)}`;
}

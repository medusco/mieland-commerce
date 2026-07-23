import { getRedis } from "../redis/client.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function cookieKey(userId: number): string {
  return `wpAuthCookie:${userId}`;
}

/** Persist WP auth Cookie header for server-side Store/REST calls. Never expose to clients. */
export async function saveWpAuthCookie(
  userId: number,
  cookieHeader: string,
  ttlSeconds?: number,
): Promise<void> {
  if (!userId || !cookieHeader.trim()) return;
  const ttl =
    Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0
      ? Math.floor(ttlSeconds as number)
      : DEFAULT_TTL_SECONDS;
  await getRedis().set(cookieKey(userId), cookieHeader.trim(), "EX", ttl);
}

export async function getWpAuthCookie(userId: number): Promise<string | null> {
  if (!userId) return null;
  const raw = await getRedis().get(cookieKey(userId));
  return raw?.trim() || null;
}

export async function clearWpAuthCookie(userId: number): Promise<void> {
  if (!userId) return;
  await getRedis().del(cookieKey(userId));
}

/**
 * Require a stored WP auth cookie for logged-in checkout/payment.
 * Forces re-login when Redis TTL expired or user logged in before cookie vault existed.
 */
export async function requireWpAuthCookie(userId: number): Promise<string> {
  const cookie = await getWpAuthCookie(userId);
  if (!cookie) {
    throw new Error(
      "WordPress session expired — please log in again to place or pay for orders",
    );
  }
  return cookie;
}

import { getRedis } from "../redis/client.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function wpRefreshKey(userId: number): string {
  return `wp-refresh:${userId}`;
}

function ttlSecondsFromExpiration(expirationIso?: string | null): number {
  if (!expirationIso?.trim()) return DEFAULT_TTL_SECONDS;
  const expiresAt = Date.parse(expirationIso);
  if (Number.isNaN(expiresAt)) return DEFAULT_TTL_SECONDS;
  const seconds = Math.floor((expiresAt - Date.now()) / 1000);
  return seconds > 60 ? seconds : DEFAULT_TTL_SECONDS;
}

export async function storeWpRefreshToken(
  userId: number,
  refreshToken: string,
  expirationIso?: string | null,
): Promise<void> {
  const token = refreshToken.trim();
  if (!userId || !token) return;
  const ttl = ttlSecondsFromExpiration(expirationIso);
  await getRedis().set(wpRefreshKey(userId), token, "EX", ttl);
}

export async function loadWpRefreshToken(userId: number): Promise<string | null> {
  if (!userId) return null;
  const token = await getRedis().get(wpRefreshKey(userId));
  return token?.trim() || null;
}

export async function clearWpRefreshToken(userId: number): Promise<void> {
  if (!userId) return;
  await getRedis().del(wpRefreshKey(userId));
}

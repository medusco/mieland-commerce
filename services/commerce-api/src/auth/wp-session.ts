import { loadConfig } from "../config.js";
import { getWpAuthCookie } from "./wp-auth-store.js";

/**
 * WP auth cookies: HttpOnly `mc-wp-session` on the client when possible, plus
 * Redis `wp-auth:{userId}` written at login so cross-origin storefronts can pay
 * without relying on third-party cookies.
 */

/** HttpOnly cookie name set by commerce on login (not a WordPress cookie name). */
export const WP_AUTH_COOKIE_NAME = "mc-wp-session";

/** Optional request header (proxy may forward the cookie value here). */
export const WP_AUTH_HEADER_NAME = "x-mc-wp-session";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

/**
 * Build a Set-Cookie header that stores the WP Cookie request header value.
 * Value is URI-encoded so `;` / `=` inside WP pairs stay intact.
 */
export function buildWpAuthSetCookie(
  cookieHeader: string,
  ttlSeconds?: number,
): string {
  const ttl =
    Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0
      ? Math.floor(ttlSeconds as number)
      : DEFAULT_TTL_SECONDS;
  const cfg = loadConfig();
  // Cross-origin storefront → commerce (e.g. localhost/Vercel → Railway) needs
  // SameSite=None; Secure so credentialed fetches include the cookie. Local HTTP
  // commerce (same-site localhost ports) keeps Lax without Secure.
  const parts = [
    `${WP_AUTH_COOKIE_NAME}=${encodeURIComponent(cookieHeader.trim())}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${ttl}`,
  ];
  if (cfg.isProd) {
    parts.push("SameSite=None", "Secure", "Partitioned");
  } else {
    parts.push("SameSite=Lax");
  }
  return parts.join("; ");
}

/** Read the WP Cookie header value from an incoming Cookie request header. */
export function parseWpAuthCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader?.trim()) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== WP_AUTH_COOKIE_NAME) continue;
    const raw = trimmed.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw).trim() || null;
    } catch {
      return raw.trim() || null;
    }
  }
  return null;
}

/** Decode a raw `x-mc-wp-session` / cookie value (URI-encoded or plain). */
export function decodeWpAuthCookieValue(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim() || "";
  if (!trimmed) return null;
  try {
    return decodeURIComponent(trimmed).trim() || null;
  } catch {
    return trimmed;
  }
}

/**
 * Resolve WP auth for Store API: browser cookie / header, else Redis from login.
 */
export async function resolveWpAuthCookie(opts: {
  cookie?: string | null;
  userId?: number | null;
}): Promise<string> {
  const fromClient = opts.cookie?.trim() || "";
  if (fromClient) return fromClient;

  const userId = opts.userId ?? null;
  if (userId != null) {
    const stored = await getWpAuthCookie(userId);
    if (stored) return stored;
  }

  throw new Error(
    "WordPress session required — log in again (missing mc-wp-session cookie)",
  );
}

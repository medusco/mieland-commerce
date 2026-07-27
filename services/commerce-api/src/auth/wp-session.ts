import { loadConfig } from "../config.js";

/**
 * WP auth cookies are client-held as an HttpOnly cookie on the commerce domain.
 * Login sets the cookie; checkout/pay read it and forward to WP Store API.
 * Commerce never stores the cookie in Redis.
 */

/** HttpOnly cookie name set by commerce on login (not a WordPress cookie name). */
export const WP_AUTH_COOKIE_NAME = "mc-wp-session";

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

/**
 * Require a client-supplied WP auth cookie for logged-in checkout/payment.
 * Forces re-login when the browser omitted the cookie or the WP session expired.
 */
export function requireWpAuthCookie(cookie: string | null | undefined): string {
  const trimmed = cookie?.trim() || "";
  if (!trimmed) {
    throw new Error(
      "WordPress session required — log in again (missing mc-wp-session cookie)",
    );
  }
  return trimmed;
}

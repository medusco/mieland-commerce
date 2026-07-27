import { loadConfig } from "../config.js";

/**
 * WP auth cookies: HttpOnly `mc-wp-session` on the client (never Redis).
 * Commerce captures WP Set-Cookie on login and re-emits them wrapped in this cookie.
 */

/** HttpOnly cookie name set by commerce on login (not a WordPress cookie name). */
export const WP_AUTH_COOKIE_NAME = "mc-wp-session";

/** Optional request/response header (proxy may forward the cookie value here). */
export const WP_AUTH_HEADER_NAME = "x-mc-wp-session";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export type WpAuthSetCookieOptions = {
  /** When true (HTTPS / prod / cross-site), emit SameSite=None; Secure; Partitioned. */
  crossSite?: boolean;
};

/**
 * Build a Set-Cookie header that stores the WP Cookie request header value.
 * Value is URI-encoded so `;` / `=` inside WP pairs stay intact.
 */
export function buildWpAuthSetCookie(
  cookieHeader: string,
  ttlSeconds?: number,
  opts?: WpAuthSetCookieOptions,
): string {
  const ttl =
    Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0
      ? Math.floor(ttlSeconds as number)
      : DEFAULT_TTL_SECONDS;
  const cfg = loadConfig();
  const crossSite = Boolean(opts?.crossSite || cfg.isProd);
  // Cross-origin storefront → commerce needs SameSite=None; Secure. Local same-site
  // HTTP keeps Lax (browsers reject SameSite=None without Secure on plain HTTP).
  const parts = [
    `${WP_AUTH_COOKIE_NAME}=${encodeURIComponent(cookieHeader.trim())}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${ttl}`,
  ];
  if (crossSite) {
    parts.push("SameSite=None", "Secure", "Partitioned");
  } else {
    parts.push("SameSite=Lax");
  }
  return parts.join("; ");
}

/** Cookie pair value only (URI-encoded), for `x-mc-wp-session` response header. */
export function wpAuthHeaderValue(cookieHeader: string): string {
  return encodeURIComponent(cookieHeader.trim());
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
 * Require a browser-held WP auth cookie (from `mc-wp-session`).
 * Used by checkout / createOrder / processOrderPayment for logged-in payers.
 */
export function requireWpAuthCookie(
  cookie: string | null | undefined,
): string {
  const trimmed = cookie?.trim() || "";
  if (!trimmed) {
    throw new Error(
      "WordPress session required — log in again (missing mc-wp-session cookie)",
    );
  }
  return trimmed;
}

/**
 * Resolve WP auth for Store API from the browser cookie / decoded header value.
 */
export async function resolveWpAuthCookie(opts: {
  cookie?: string | null;
  userId?: number | null;
}): Promise<string> {
  void opts.userId;
  return requireWpAuthCookie(opts.cookie);
}

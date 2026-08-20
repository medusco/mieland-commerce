import { loadConfig } from "../config.js";
import { wpGraphqlViewerDatabaseId } from "../clients/wordpress-graphql.js";
import { findUserByLoginOrEmail } from "./index.js";
import type { WpCookiePolicy } from "./cookie-policy.js";

/**
 * WP auth cookies: HttpOnly `mc-wp-session` on the client (never Redis).
 * Commerce captures WP Set-Cookie on login and re-emits them wrapped in this cookie.
 */

/** HttpOnly cookie name set by commerce on login (not a WordPress cookie name). */
export const WP_AUTH_COOKIE_NAME = "mc-wp-session";

/** HttpOnly cookie holding the WP Headless Login refresh token. */
export const WP_REFRESH_COOKIE_NAME = "mc-wp-refresh";

/** Optional request/response header (proxy may forward the cookie value here). */
export const WP_AUTH_HEADER_NAME = "x-mc-wp-session";

export const WP_REFRESH_HEADER_NAME = "x-mc-wp-refresh";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type WpAuthSetCookieOptions = {
  /** Cookie policy from {@link resolveWpCookiePolicy}. */
  policy: WpCookiePolicy;
};

function appendCookiePolicy(parts: string[], policy: WpCookiePolicy): void {
  if (policy.domain?.trim()) {
    parts.push(`Domain=${policy.domain.trim()}`);
  }
  parts.push(`SameSite=${policy.sameSite === "none" ? "None" : "Lax"}`);
  if (policy.secure) parts.push("Secure");
  if (policy.partitioned) parts.push("Partitioned");
}

/**
 * Build a Set-Cookie header that stores the WP Cookie request header value.
 * Value is URI-encoded so `;` / `=` inside WP pairs stay intact.
 */
export function buildWpAuthSetCookie(
  cookieHeader: string,
  ttlSeconds: number | undefined,
  opts: WpAuthSetCookieOptions,
): string {
  // Never emit a wrapper shorter than 14 days — WP often returns ~2d Max-Age
  // without remember-me; JWT refresh renews the inner cookies while this lasts.
  const ttl =
    Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0
      ? Math.max(DEFAULT_TTL_SECONDS, Math.floor(ttlSeconds as number))
      : DEFAULT_TTL_SECONDS;
  void loadConfig;
  const parts = [
    `${WP_AUTH_COOKIE_NAME}=${encodeURIComponent(cookieHeader.trim())}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${ttl}`,
  ];
  appendCookiePolicy(parts, opts.policy);
  return parts.join("; ");
}

function ttlFromExpiration(
  fallback: number,
  expirationIso?: string | null,
): number {
  if (!expirationIso) return fallback;
  const ms = Date.parse(expirationIso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.max(60, Math.floor(ms / 1000));
}

function buildNamedSetCookie(
  name: string,
  value: string,
  ttlSeconds: number,
  opts: WpAuthSetCookieOptions,
): string {
  void loadConfig;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${ttlSeconds}`,
  ];
  appendCookiePolicy(parts, opts.policy);
  return parts.join("; ");
}

function buildNamedClearCookie(
  name: string,
  opts: WpAuthSetCookieOptions,
): string {
  void loadConfig;
  const parts = [`${name}=`, "Path=/", "HttpOnly", "Max-Age=0"];
  appendCookiePolicy(parts, opts.policy);
  return parts.join("; ");
}

/** Set HttpOnly `mc-wp-refresh` (WP Headless Login refresh token). */
export function buildWpRefreshSetCookie(
  refreshToken: string,
  expirationIso: string | null | undefined,
  opts: WpAuthSetCookieOptions,
): string {
  const ttl = ttlFromExpiration(DEFAULT_REFRESH_TTL_SECONDS, expirationIso);
  return buildNamedSetCookie(
    WP_REFRESH_COOKIE_NAME,
    refreshToken.trim(),
    ttl,
    opts,
  );
}

/** Expire the HttpOnly `mc-wp-refresh` cookie. */
export function buildWpRefreshClearCookie(
  opts: WpAuthSetCookieOptions,
): string {
  return buildNamedClearCookie(WP_REFRESH_COOKIE_NAME, opts);
}

/** Expire the HttpOnly `mc-wp-session` cookie (force logout). */
export function buildWpAuthClearCookie(
  opts: WpAuthSetCookieOptions,
): string {
  return buildNamedClearCookie(WP_AUTH_COOKIE_NAME, opts);
}

/** Cookie pair value only (URI-encoded), for `x-mc-wp-session` response header. */
export function wpAuthHeaderValue(cookieHeader: string): string {
  return encodeURIComponent(cookieHeader.trim());
}

export function wpRefreshHeaderValue(refreshToken: string): string {
  return encodeURIComponent(refreshToken.trim());
}

function parseRequestCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader?.trim()) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
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

/** Read the WP Cookie header value from an incoming Cookie request header. */
export function parseWpAuthCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  return parseRequestCookie(cookieHeader, WP_AUTH_COOKIE_NAME);
}

/** Read the WP refresh token from an incoming Cookie request header. */
export function parseWpRefreshCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  return parseRequestCookie(cookieHeader, WP_REFRESH_COOKIE_NAME);
}

/** Decode a raw `x-mc-wp-refresh` / cookie value (URI-encoded or plain). */
export function decodeWpRefreshCookieValue(
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
  const cookie = requireWpAuthCookie(opts.cookie);
  if (
    opts.userId != null &&
    !(await isWpSessionMatchingUser(cookie, opts.userId))
  ) {
    throw new Error("wp_session_mismatch");
  }
  return cookie;
}

/** Extract WP user_login from a Cookie header value (wordpress_logged_in_* pair). */
export function parseWpLoggedInUserLogin(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!/^wordpress_logged_in_/i.test(name)) continue;
    let value = trimmed.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    const login = value.split("|")[0]?.trim();
    return login || null;
  }
  return null;
}

/** Resolve WP user id from mc-wp-session (null when cookie is missing/invalid). */
export async function wpSessionUserId(
  cookieHeader: string,
): Promise<number | null> {
  const login = parseWpLoggedInUserLogin(cookieHeader);
  if (!login) return null;
  const user = await findUserByLoginOrEmail(login);
  return user?.id ?? null;
}

/** True when wordpress_logged_in_* in mc-wp-session matches the JWT user. */
export async function isWpSessionMatchingUser(
  cookieHeader: string,
  userId: number,
): Promise<boolean> {
  const sessionUserId = await wpSessionUserId(cookieHeader);
  return sessionUserId === userId;
}

/**
 * Resolve the live WP user id for a Cookie header.
 * Prefers WPGraphQL viewer (Headless Login customers); falls back to REST /users/me.
 */
export async function getLiveWpUserIdFromCookie(
  cookieHeader: string,
  origin?: string | null,
): Promise<number | null> {
  const trimmed = cookieHeader?.trim() || "";
  if (!trimmed) return null;

  const fromGraphql = await wpGraphqlViewerDatabaseId(trimmed, origin);
  if (fromGraphql != null) return fromGraphql;

  const cfg = loadConfig();
  const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/wp/v2/users/me`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: trimmed,
      },
      signal: AbortSignal.timeout(cfg.WC_REST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    const id = Number(body.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** True when WP accepts the cookie and the authenticated user matches. */
export async function isWpSessionAliveForUser(
  cookieHeader: string,
  userId: number,
  origin?: string | null,
): Promise<boolean> {
  const liveId = await getLiveWpUserIdFromCookie(cookieHeader, origin);
  return liveId === userId;
}

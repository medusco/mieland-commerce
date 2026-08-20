import { wpGraphqlRefreshToken } from "../clients/wordpress-graphql.js";
import {
  scheduleWpAuthSetCookie,
  scheduleWpRefreshSetCookie,
} from "../context.js";
import { wpAuthHeaderValue, wpRefreshHeaderValue } from "./wp-session.js";

export type RefreshWpSessionOpts = {
  requestScopeId: string;
  req: Request;
  origin?: string | null;
  /** WP Headless Login refresh token from `mc-wp-refresh` cookie or `x-mc-wp-refresh` header. */
  wpRefreshToken?: string | null;
};

export type WpSessionRenewal = {
  cookieHeader: string;
  sessionHeaderValue: string;
  refreshHeaderValue: string | null;
};

/**
 * Renew wordpress_logged_in_* via WP GraphQL refreshToken and emit mc-wp-session.
 * Returns renewed session values, or null when refresh is unavailable.
 */
export async function refreshWpSessionFromCookie(
  opts: RefreshWpSessionOpts,
): Promise<WpSessionRenewal | null> {
  const wpRefresh = opts.wpRefreshToken?.trim() || "";
  if (!wpRefresh) return null;

  const wp = await wpGraphqlRefreshToken(wpRefresh, { origin: opts.origin });
  if (!wp.success || !wp.cookieHeader) return null;

  scheduleWpAuthSetCookie(
    opts.requestScopeId,
    opts.req,
    wp.cookieHeader,
    wp.cookieTtlSeconds,
  );

  let refreshHeaderValue: string | null = null;
  if (wp.refreshToken) {
    scheduleWpRefreshSetCookie(
      opts.requestScopeId,
      opts.req,
      wp.refreshToken,
      wp.refreshTokenExpiration,
    );
    refreshHeaderValue = wpRefreshHeaderValue(wp.refreshToken);
  }

  return {
    cookieHeader: wp.cookieHeader,
    sessionHeaderValue: wpAuthHeaderValue(wp.cookieHeader),
    refreshHeaderValue,
  };
}

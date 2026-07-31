import { wpGraphqlRefreshToken } from "../clients/wordpress-graphql.js";
import {
  scheduleWpAuthSetCookie,
  scheduleWpRefreshSetCookie,
} from "../context.js";

export type RefreshWpSessionOpts = {
  requestScopeId: string;
  req: Request;
  origin?: string | null;
  /** WP Headless Login refresh token from `mc-wp-refresh` cookie. */
  wpRefreshToken?: string | null;
};

/**
 * Renew wordpress_logged_in_* via WP GraphQL refreshToken and emit mc-wp-session.
 * Returns the new Cookie header value, or null when refresh is unavailable.
 */
export async function refreshWpSessionFromCookie(
  opts: RefreshWpSessionOpts,
): Promise<string | null> {
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
  if (wp.refreshToken) {
    scheduleWpRefreshSetCookie(
      opts.requestScopeId,
      opts.req,
      wp.refreshToken,
      wp.refreshTokenExpiration,
    );
  }
  return wp.cookieHeader;
}

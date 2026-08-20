import { wpGraphqlRefreshToken } from "../clients/wordpress-graphql.js";
import {
  scheduleWpAuthSetCookie,
  scheduleWpRefreshSetCookie,
} from "../context.js";
import {
  loadWpRefreshToken,
  storeWpRefreshToken,
} from "./wp-refresh-store.js";
import { wpAuthHeaderValue, wpRefreshHeaderValue } from "./wp-session.js";

export type RefreshWpSessionOpts = {
  requestScopeId: string;
  req: Request;
  origin?: string | null;
  /** WP Headless Login refresh token from `mc-wp-refresh` cookie/header. */
  wpRefreshToken?: string | null;
  /** Fallback when the client cannot send cross-origin refresh headers. */
  userId?: number | null;
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
  let wpRefresh = opts.wpRefreshToken?.trim() || "";
  if (!wpRefresh && opts.userId != null) {
    wpRefresh = (await loadWpRefreshToken(opts.userId)) ?? "";
  }
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
    if (opts.userId != null) {
      await storeWpRefreshToken(
        opts.userId,
        wp.refreshToken,
        wp.refreshTokenExpiration,
      );
    }
  }

  return {
    cookieHeader: wp.cookieHeader,
    sessionHeaderValue: wpAuthHeaderValue(wp.cookieHeader),
    refreshHeaderValue,
  };
}

import type { YogaInitialContext } from "graphql-yoga";
import DataLoader from "dataloader";
import {
  parseSessionHeader,
  randomToken,
  requestId,
} from "./utils/index.js";
import { verifyAccessToken } from "./auth/index.js";
import {
  buildWpAuthClearCookie,
  buildWpAuthSetCookie,
  buildWpRefreshClearCookie,
  buildWpRefreshSetCookie,
  decodeWpRefreshCookieValue,
  inspectWpCookieEncoding,
  parseWpAuthCookieHeader,
  parseWpRefreshCookieHeader,
  wpAuthHeaderValue,
  wpRefreshHeaderValue,
  WP_AUTH_HEADER_NAME,
  WP_REFRESH_HEADER_NAME,
} from "./auth/wp-session.js";
import { getProductNodes } from "./repositories/products.js";
import { loadConfig } from "./config.js";
import { resolveWpCookiePolicy } from "./auth/cookie-policy.js";
import { logPaymentTrace } from "./utils/payment-trace.js";

export {
  isCrossOriginRequest,
  isCrossOriginRequest as isCrossSiteRequest,
  isSecureRequest,
} from "./auth/cookie-policy.js";

/** GraphQL extension code + response header when auth cookies are cleared server-side. */
export const FORCE_LOGOUT_CODE = "FORCE_LOGOUT";
export const FORCE_LOGOUT_HEADER = "x-mc-force-logout";

export type AppContext = {
  requestId: string;
  /** Matches Express `x-mc-request-scope` for pending Set-Cookie handoff. */
  requestScopeId: string;
  sessionToken: string;
  setSessionToken: string | null;
  userId: number | null;
  /** Decoded WP Cookie header from the `mc-wp-session` HttpOnly cookie. */
  wpAuthCookie: string | null;
  /** WP Headless Login refresh token from `mc-wp-refresh` HttpOnly cookie. */
  wpRefreshToken: string | null;
  /** Set-Cookie to emit after login (HttpOnly `mc-wp-session`). */
  pendingWpAuthSetCookie: string | null;
  calcMode: "lightweight" | "full";
  productLoader: DataLoader<number, unknown>;
  req: Request;
};

/** Internal header so Express can recover pending login cookies after yoga.fetch. */
export const REQUEST_SCOPE_HEADER = "x-mc-request-scope";

/**
 * Pending login cookies by scope id. Written from the login resolver; read by Express.
 * Do not rely on mutating Yoga context alone — plugins may wrap/replace contextValue.
 */
type PendingWpAuth = {
  setCookies: string[];
  sessionHeaderValue: string;
  refreshHeaderValue: string;
  forceLogout?: boolean;
};
const pendingWpAuthByScope = new Map<string, PendingWpAuth>();

function ensurePending(scopeId: string): PendingWpAuth {
  const key = scopeId.trim();
  let pending = pendingWpAuthByScope.get(key);
  if (!pending) {
    pending = {
      setCookies: [],
      sessionHeaderValue: "",
      refreshHeaderValue: "",
    };
    pendingWpAuthByScope.set(key, pending);
  }
  return pending;
}

function appendPendingSetCookie(scopeId: string, setCookie: string): void {
  const cookie = setCookie.trim();
  if (!scopeId.trim() || !cookie) return;
  ensurePending(scopeId).setCookies.push(cookie);
}

/** Clear mc-wp-session + mc-wp-refresh and tell the client to drop JWT. */
export function scheduleForceLogout(scopeId: string, req: Request): void {
  if (!scopeId.trim()) return;
  const policy = resolveWpCookiePolicy(req);
  const pending = ensurePending(scopeId);
  pending.setCookies = [
    buildWpAuthClearCookie({ policy }),
    buildWpRefreshClearCookie({ policy }),
  ];
  pending.sessionHeaderValue = "";
  pending.refreshHeaderValue = "";
  pending.forceLogout = true;
}

export function setPendingWpAuthSetCookie(
  scopeId: string,
  setCookie: string,
  headerValue?: string,
): void {
  appendPendingSetCookie(scopeId, setCookie);
  if (headerValue?.trim()) {
    ensurePending(scopeId).sessionHeaderValue = headerValue.trim();
  }
}

/** Emit a fresh HttpOnly `mc-wp-session` after WP session renewal. */
export function scheduleWpAuthSetCookie(
  scopeId: string,
  req: Request,
  cookieHeader: string,
  ttlSeconds?: number,
): void {
  if (!scopeId.trim() || !cookieHeader.trim()) return;
  const policy = resolveWpCookiePolicy(req);
  appendPendingSetCookie(
    scopeId,
    buildWpAuthSetCookie(cookieHeader, ttlSeconds, { policy }),
  );
  ensurePending(scopeId).sessionHeaderValue = wpAuthHeaderValue(cookieHeader);
}

/** Emit a fresh HttpOnly `mc-wp-refresh` after WP token rotation. */
export function scheduleWpRefreshSetCookie(
  scopeId: string,
  req: Request,
  refreshToken: string,
  expirationIso?: string | null,
): void {
  if (!scopeId.trim() || !refreshToken.trim()) return;
  const policy = resolveWpCookiePolicy(req);
  appendPendingSetCookie(
    scopeId,
    buildWpRefreshSetCookie(refreshToken, expirationIso, { policy }),
  );
  ensurePending(scopeId).refreshHeaderValue =
    wpRefreshHeaderValue(refreshToken);
}

export function takePendingWpAuthSetCookie(
  scopeId: string,
): PendingWpAuth | null {
  const key = scopeId.trim();
  if (!key) return null;
  const value = pendingWpAuthByScope.get(key) ?? null;
  pendingWpAuthByScope.delete(key);
  return value;
}

export async function buildContext(
  yogaCtx: YogaInitialContext,
): Promise<AppContext> {
  const req = yogaCtx.request;
  const headers = req.headers;
  const rid = headers.get("x-request-id") || requestId();
  const scopeId = headers.get(REQUEST_SCOPE_HEADER)?.trim() || "";

  let sessionToken =
    parseSessionHeader(headers.get("woocommerce-session")) ||
    parseSessionHeader(headers.get("Woocommerce-Session"));
  let setSessionToken: string | null = null;
  if (!sessionToken) {
    sessionToken = randomToken(24);
    setSessionToken = sessionToken;
  }

  let userId: number | null = null;
  const auth = headers.get("authorization") || headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const verified = await verifyAccessToken(token);
    if (verified) userId = verified.userId;
  }

  const rawWpHeader = headers.get(WP_AUTH_HEADER_NAME);
  const headerEncoding = inspectWpCookieEncoding(rawWpHeader);
  const wpAuthCookie =
    parseWpAuthCookieHeader(headers.get("cookie")) ||
    headerEncoding.normalized;
  const wpRefreshToken =
    parseWpRefreshCookieHeader(headers.get("cookie")) ||
    decodeWpRefreshCookieValue(headers.get(WP_REFRESH_HEADER_NAME));

  if (
    headerEncoding.hadValue &&
    (headerEncoding.wasChanged || headerEncoding.hadDoubleEncodedPipe)
  ) {
    logPaymentTrace("info", {
      msg: "wp_session_encoding_normalized",
      requestId: rid,
      jwtUserId: userId,
      source: "x-mc-wp-session",
      decodePasses: headerEncoding.decodePasses,
      wasChanged: headerEncoding.wasChanged,
      hadDoubleEncodedPipe: headerEncoding.hadDoubleEncodedPipe,
      hasSingleEncodedPipe: headerEncoding.hasSingleEncodedPipe,
      rawLength: headerEncoding.rawLength,
      normalizedLength: headerEncoding.normalizedLength,
      headerMcWpSessionRaw: rawWpHeader,
      normalizedWpSession: headerEncoding.normalized,
    });
  }

  const productLoader = new DataLoader(async (ids: readonly number[]) => {
    return getProductNodes(ids);
  });

  void loadConfig;
  return {
    requestId: rid,
    requestScopeId: scopeId,
    sessionToken,
    setSessionToken,
    userId,
    wpAuthCookie,
    wpRefreshToken,
    pendingWpAuthSetCookie: null,
    calcMode: "lightweight",
    productLoader,
    req,
  };
}

export function requireUser(ctx: AppContext): number {
  if (!ctx.userId) {
    throw new Error("Authentication required");
  }
  return ctx.userId;
}

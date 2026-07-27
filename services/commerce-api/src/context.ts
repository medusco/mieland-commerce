import type { YogaInitialContext } from "graphql-yoga";
import DataLoader from "dataloader";
import {
  parseSessionHeader,
  randomToken,
  requestId,
} from "./utils/index.js";
import { verifyAccessToken } from "./auth/index.js";
import {
  decodeWpAuthCookieValue,
  parseWpAuthCookieHeader,
  WP_AUTH_HEADER_NAME,
} from "./auth/wp-session.js";
import { getProductNodes } from "./repositories/products.js";
import { loadConfig } from "./config.js";

export type AppContext = {
  requestId: string;
  /** Matches Express `x-mc-request-scope` for pending Set-Cookie handoff. */
  requestScopeId: string;
  sessionToken: string;
  setSessionToken: string | null;
  userId: number | null;
  /** Decoded WP Cookie header from the `mc-wp-session` HttpOnly cookie. */
  wpAuthCookie: string | null;
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
type PendingWpAuth = { setCookie: string; headerValue: string };
const pendingWpAuthByScope = new Map<string, PendingWpAuth>();

export function setPendingWpAuthSetCookie(
  scopeId: string,
  setCookie: string,
  headerValue?: string,
): void {
  if (!scopeId.trim() || !setCookie.trim()) return;
  pendingWpAuthByScope.set(scopeId.trim(), {
    setCookie: setCookie.trim(),
    headerValue: (headerValue ?? "").trim(),
  });
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

  const wpAuthCookie =
    parseWpAuthCookieHeader(headers.get("cookie")) ||
    decodeWpAuthCookieValue(headers.get(WP_AUTH_HEADER_NAME));

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

/** True when Origin is cross-site relative to the request Host (needs SameSite=None). */
export function isCrossSiteRequest(req: Request): boolean {
  const origin = req.headers.get("origin") || req.headers.get("Origin");
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const reqUrl = new URL(req.url);
    return Boolean(originHost) && originHost !== reqUrl.host;
  } catch {
    return false;
  }
}

/** True when the client hit commerce over HTTPS (incl. Railway / proxies). */
export function isSecureRequest(req: Request): boolean {
  if (req.url.startsWith("https://")) return true;
  const proto = (
    req.headers.get("x-forwarded-proto") ||
    req.headers.get("X-Forwarded-Proto") ||
    ""
  )
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  return proto === "https";
}

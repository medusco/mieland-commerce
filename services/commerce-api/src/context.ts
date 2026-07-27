import type { YogaInitialContext } from "graphql-yoga";
import DataLoader from "dataloader";
import {
  parseSessionHeader,
  randomToken,
  requestId,
} from "./utils/index.js";
import { verifyAccessToken } from "./auth/index.js";
import { parseWpAuthCookieHeader } from "./auth/wp-session.js";
import { getProductNodes } from "./repositories/products.js";
import { loadConfig } from "./config.js";

export type AppContext = {
  requestId: string;
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

/** Internal header so Express can recover context after yoga.fetch. */
export const REQUEST_SCOPE_HEADER = "x-mc-request-scope";

/**
 * Scope-id → context. Used instead of AsyncLocalStorage because undici `fetch`
 * (WP login) can clear ALS, so Express would lose pendingWpAuthSetCookie even
 * though the Yoga context still had it set.
 */
const contextByScopeId = new Map<string, AppContext>();

export function registerRequestScope(scopeId: string, ctx: AppContext): void {
  contextByScopeId.set(scopeId, ctx);
}

export function takeContextForScope(scopeId: string): AppContext | null {
  const ctx = contextByScopeId.get(scopeId) ?? null;
  contextByScopeId.delete(scopeId);
  return ctx;
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

  const wpAuthCookie = parseWpAuthCookieHeader(headers.get("cookie"));

  const productLoader = new DataLoader(async (ids: readonly number[]) => {
    return getProductNodes(ids);
  });

  void loadConfig;
  const ctx: AppContext = {
    requestId: rid,
    sessionToken,
    setSessionToken,
    userId,
    wpAuthCookie,
    pendingWpAuthSetCookie: null,
    calcMode: "lightweight",
    productLoader,
    req,
  };
  if (scopeId) registerRequestScope(scopeId, ctx);
  return ctx;
}

export function requireUser(ctx: AppContext): number {
  if (!ctx.userId) {
    throw new Error("Authentication required");
  }
  return ctx.userId;
}

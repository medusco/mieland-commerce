import { AsyncLocalStorage } from "node:async_hooks";
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

/** Request-scoped bag so Express can read pending Set-Cookie after yoga.fetch. */
type RequestScope = { ctx: AppContext | null };
const requestScope = new AsyncLocalStorage<RequestScope>();

export function runWithRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return requestScope.run({ ctx: null }, fn);
}

export function getRequestScopedContext(): AppContext | null {
  return requestScope.getStore()?.ctx ?? null;
}

export async function buildContext(
  yogaCtx: YogaInitialContext,
): Promise<AppContext> {
  const req = yogaCtx.request;
  const headers = req.headers;
  const rid = headers.get("x-request-id") || requestId();

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
  const scope = requestScope.getStore();
  if (scope) scope.ctx = ctx;
  return ctx;
}

export function requireUser(ctx: AppContext): number {
  if (!ctx.userId) {
    throw new Error("Authentication required");
  }
  return ctx.userId;
}

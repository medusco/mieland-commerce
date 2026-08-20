import type { AppContext } from "../context.js";
import {
  parseWpAuthCookieHeader,
  parseWpLoggedInUserLogin,
  parseWpRefreshCookieHeader,
  WP_AUTH_HEADER_NAME,
  WP_REFRESH_HEADER_NAME,
} from "../auth/wp-session.js";
import { parseSessionHeader } from "./index.js";
import type { Request } from "express";

/** Payment/checkout logs — no PII redaction (Railway / internal debugging). */
export function logPaymentTrace(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Incoming auth headers + parsed WP session for checkout / pay mutations. */
export function paymentAuthSnapshot(ctx: AppContext): Record<string, unknown> {
  const headers = ctx.req.headers;
  const requestCookieHeader = headers.get("cookie");
  const mcWpFromRequestCookie = parseWpAuthCookieHeader(requestCookieHeader);
  const mcWpRefreshFromRequestCookie =
    parseWpRefreshCookieHeader(requestCookieHeader);
  const mcWpFromHeader = headers.get(WP_AUTH_HEADER_NAME);
  const mcWpRefreshFromHeader = headers.get(WP_REFRESH_HEADER_NAME);
  const wpCookie =
    ctx.wpAuthCookie?.trim() ||
    mcWpFromRequestCookie?.trim() ||
    mcWpFromHeader?.trim() ||
    null;

  return {
    requestId: ctx.requestId,
    jwtUserId: ctx.userId,
    commerceSessionToken: ctx.sessionToken,
    mcWpSessionFromContext: ctx.wpAuthCookie ?? null,
    mcWpRefreshFromContext: ctx.wpRefreshToken ?? null,
    mcWpSessionFromRequestCookie: mcWpFromRequestCookie,
    mcWpRefreshFromRequestCookie: mcWpRefreshFromRequestCookie,
    headerMcWpSession: mcWpFromHeader,
    headerMcWpRefresh: mcWpRefreshFromHeader,
    wpLoggedInLogin: wpCookie ? parseWpLoggedInUserLogin(wpCookie) : null,
    headerWoocommerceSession:
      headers.get("woocommerce-session") ??
      headers.get("Woocommerce-Session"),
    commerceSessionFromHeader: parseSessionHeader(
      headers.get("woocommerce-session") ??
        headers.get("Woocommerce-Session"),
    ),
    hasAuthorizationBearer: Boolean(
      headers.get("authorization")?.toLowerCase().startsWith("bearer ") ||
        headers.get("Authorization")?.toLowerCase().startsWith("bearer "),
    ),
    origin: headers.get("origin") ?? headers.get("Origin"),
    referer: headers.get("referer") ?? headers.get("Referer"),
    requestCookieHeader,
  };
}

export function summarizePaymentData(
  paymentData: Array<{ key: string; value?: string | boolean | null }>,
): Record<string, unknown> {
  const keys = paymentData.map((p) => p.key);
  const summary: Record<string, string> = {};
  for (const item of paymentData) {
    const key = item.key?.trim();
    if (!key) continue;
    const raw = item.value;
    if (raw === null || raw === undefined) {
      summary[key] = "";
      continue;
    }
    summary[key] = typeof raw === "boolean" ? String(raw) : String(raw);
  }
  return { paymentDataKeys: keys, paymentData: summary };
}

const PAYMENT_GRAPHQL_OPERATIONS = new Set([
  "CheckOut",
  "Checkout",
  "ProcessOrderPayment",
  "CreateOrder",
  "CreatePayPalOrder",
  "CalculateCartTax",
]);

export function isPaymentGraphqlOperation(
  operationName: string | null | undefined,
): boolean {
  if (!operationName?.trim()) return false;
  return PAYMENT_GRAPHQL_OPERATIONS.has(operationName.trim());
}

/** Auth headers on the incoming Express request (before Yoga context). */
export function expressPaymentAuthSnapshot(
  req: Request,
): Record<string, unknown> {
  const requestCookieHeader = req.header("cookie") ?? null;
  const mcWpFromRequestCookie = parseWpAuthCookieHeader(requestCookieHeader);
  const mcWpRefreshFromRequestCookie =
    parseWpRefreshCookieHeader(requestCookieHeader);
  const mcWpFromHeader = req.header(WP_AUTH_HEADER_NAME);
  const wpCookie =
    mcWpFromRequestCookie?.trim() || mcWpFromHeader?.trim() || null;

  return {
    requestCookieHeader,
    mcWpSessionFromRequestCookie: mcWpFromRequestCookie,
    mcWpRefreshFromRequestCookie: mcWpRefreshFromRequestCookie,
    headerMcWpSession: mcWpFromHeader,
    headerMcWpRefresh: req.header(WP_REFRESH_HEADER_NAME),
    wpLoggedInLogin: wpCookie ? parseWpLoggedInUserLogin(wpCookie) : null,
    headerWoocommerceSession:
      req.header("woocommerce-session") ?? req.header("Woocommerce-Session"),
    commerceSessionFromHeader: parseSessionHeader(
      req.header("woocommerce-session") ?? req.header("Woocommerce-Session"),
    ),
    hasAuthorizationBearer: Boolean(
      req.header("authorization")?.toLowerCase().startsWith("bearer "),
    ),
    origin: req.header("origin"),
    referer: req.header("referer"),
  };
}

import type { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import type { RedisReply, SendCommandFn } from "rate-limit-redis";
import { RedisStore } from "rate-limit-redis";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";
import { loadAccessControl } from "../auth/index.js";
import { logJson } from "../utils/index.js";

const sendCommand: SendCommandFn = async (...args: string[]) => {
  const redis = getRedis();
  return redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>;
};

export function createGraphqlRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand,
      prefix: "rl:gql:",
    }),
    keyGenerator: (req) => {
      const session = req.header("woocommerce-session") || "";
      return `${req.ip}:${session.slice(0, 40)}`;
    },
  });
}

export function createAuthMutationRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand,
      prefix: "rl:auth:",
    }),
  });
}

export async function accessControlMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cfg = loadConfig();
  const origin = req.header("origin") || "";

  // x-graphql-secret when configured
  const expectedSecret = cfg.GRAPHQL_SECRET;
  if (expectedSecret) {
    const provided = req.header("x-graphql-secret");
    if (provided !== expectedSecret) {
      res.status(401).json({ errors: [{ message: "Unauthorized" }] });
      return;
    }
  }

  try {
    const ac = await loadAccessControl();
    const origins = (ac?.allowedOrigins as string[] | undefined) ?? cfg.corsOrigins;
    const block = ac?.shouldBlockUnauthorizedDomains;
    const shouldBlock =
      block === true || block === 1 || block === "1" || block === "yes" || cfg.isProd;

    if (shouldBlock && origin && origins.length) {
      const ok = origins.some(
        (o) => o === origin || o === "*" || origin.endsWith(o.replace(/^\*/, "")),
      );
      if (!ok && !origins.includes("*")) {
        logJson("warn", { msg: "origin_blocked", origin });
        res.status(403).json({ errors: [{ message: "Origin not allowed" }] });
        return;
      }
    }
  } catch (err) {
    logJson("warn", { msg: "access_control_error", err: String(err) });
  }

  next();
}

/** Soft check: auth-sensitive operation names get stricter IP limit via header sniff. */
export function authSensitiveBodyGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body as { query?: string } | undefined;
  const q = body?.query ?? "";
  if (
    /\b(login|registerCustomer|sendPasswordResetEmail|checkout)\b/.test(q)
  ) {
    // marker for logging; actual limit applied by createAuthMutationRateLimiter on path
    res.setHeader("x-auth-sensitive", "1");
  }
  next();
}

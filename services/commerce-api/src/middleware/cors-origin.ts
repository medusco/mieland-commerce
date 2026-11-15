import type { NextFunction, Request, Response } from "express";
import { isLocalDevOrigin, logJson } from "../utils/index.js";
import { originMatchesAny } from "../utils/origin-match.js";

export type CorsOriginPolicy = {
  corsOrigins: string[];
  isProd: boolean;
};

/**
 * Allow logic for the Express `cors` origin callback.
 * Keep in sync with callers — do not tighten or loosen without an explicit change.
 */
export function isCorsOriginAllowed(
  origin: string | undefined,
  policy: CorsOriginPolicy,
): boolean {
  if (!origin) return true;
  if (isLocalDevOrigin(origin)) return true;
  if (originMatchesAny(origin, policy.corsOrigins)) {
    return true;
  }
  if (!policy.isProd && policy.corsOrigins.length === 0) return true;
  return false;
}

export type CorsOriginCallback = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;

/**
 * Origin callback for `cors`. Disallowed origins use `cb(null, false)` so Express
 * does not treat the rejection as an error (which would 500 and hit Sentry).
 */
export function createCorsOriginCallback(
  policy: CorsOriginPolicy,
  requestMeta: { method: string; path: string },
): CorsOriginCallback {
  return (origin, cb) => {
    if (isCorsOriginAllowed(origin, policy)) {
      return cb(null, true);
    }
    logJson("warn", {
      event: "cors_origin_rejected",
      origin,
      method: requestMeta.method,
      path: requestMeta.path,
    });
    return cb(null, false);
  };
}

/**
 * The `cors` package calls `next()` when the origin callback returns false, so a
 * rejected OPTIONS preflight would otherwise fall through to later handlers.
 * End those cleanly with 204 and no Access-Control-Allow-Origin.
 */
export function endRejectedCorsPreflight(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method === "OPTIONS" &&
    !res.getHeader("Access-Control-Allow-Origin")
  ) {
    res.status(204);
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  next();
}

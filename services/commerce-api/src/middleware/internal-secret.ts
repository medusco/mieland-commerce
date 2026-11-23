import type { Request, Response, NextFunction } from "express";
import { loadConfig } from "../config.js";

export const MIELAND_INTERNAL_SECRET_HEADER = "x-mieland-internal-secret";

/**
 * Matches WP internal routes: requires `X-Mieland-Internal-Secret` when
 * `MIELAND_INTERNAL_REST_SECRET` is configured.
 */
export function requireInternalRestSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = loadConfig().MIELAND_INTERNAL_REST_SECRET;
  if (!secret) {
    res.status(503).json({
      ok: false,
      message: "MIELAND_INTERNAL_REST_SECRET is not configured",
    });
    return;
  }

  const provided = req.header(MIELAND_INTERNAL_SECRET_HEADER);
  if (provided !== secret) {
    res.status(401).json({ ok: false, message: "Unauthorized" });
    return;
  }

  next();
}
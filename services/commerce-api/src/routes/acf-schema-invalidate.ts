import type { Express, Request, Response } from "express";
import {
  enqueueAcfSchemaRefresh,
  type AcfSchemaSwapTarget,
} from "../schema/acf-runtime-schema.js";
import { invalidateAcfGraphqlGroupsCache } from "../repositories/acf-graphql.js";
import {
  MIELAND_INTERNAL_SECRET_HEADER,
  requireInternalRestSecret,
} from "../middleware/internal-secret.js";

export { MIELAND_INTERNAL_SECRET_HEADER };

export function registerAcfSchemaInvalidateRoutes(
  app: Express,
  swap: AcfSchemaSwapTarget,
): void {
  app.post(
    "/internal/acf-schema/invalidate",
    requireInternalRestSecret,
    (req: Request, res: Response) => {
      void handleInvalidate(req, res, swap);
    },
  );
}

async function handleInvalidate(
  _req: Request,
  res: Response,
  swap: AcfSchemaSwapTarget,
): Promise<void> {
  const result = await enqueueAcfSchemaRefresh(
    swap,
    invalidateAcfGraphqlGroupsCache,
  );
  if (!result.ok) {
    res.status(500).json({
      ok: false,
      message: result.error ?? "ACF schema refresh failed",
      keptPreviousSchema: true,
    });
    return;
  }
  res.status(200).json({
    ok: true,
    acfGroupCount: result.acfGroupCount,
  });
}
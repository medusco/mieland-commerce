import type { YogaInitialContext } from "graphql-yoga";
import DataLoader from "dataloader";
import {
  parseSessionHeader,
  randomToken,
  requestId,
} from "./utils/index.js";
import { verifyAccessToken } from "./auth/index.js";
import { getProductNodes } from "./repositories/products.js";
import { loadConfig } from "./config.js";

export type AppContext = {
  requestId: string;
  sessionToken: string;
  setSessionToken: string | null;
  userId: number | null;
  calcMode: "lightweight" | "full";
  productLoader: DataLoader<number, unknown>;
  req: Request;
};

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

  const productLoader = new DataLoader(async (ids: readonly number[]) => {
    return getProductNodes(ids);
  });

  void loadConfig;
  return {
    requestId: rid,
    sessionToken,
    setSessionToken,
    userId,
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

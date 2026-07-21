import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Plugin } from "graphql-yoga";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";

function sha256(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

type PersistedExt = {
  persistedQuery?: { version?: number; sha256Hash?: string };
};

/**
 * Apollo APQ protocol compatible with PersistedQueryLink (sha256, GET hashed queries).
 * Unknown hash → PersistedQueryNotFound (not PersistedQueryNotSupported).
 */
export function createApqPlugin(): Plugin<AppContext> {
  return {
    async onParams({ params, setParams }) {
      const cfg = loadConfig();
      const extensions = (params.extensions ?? {}) as PersistedExt;
      const pq = extensions.persistedQuery;
      if (!pq?.sha256Hash) return;

      const hash = pq.sha256Hash;
      const redis = getRedis();
      const key = `apq:${hash}`;

      if (params.query) {
        const computed = sha256(params.query);
        if (computed !== hash) {
          throw new GraphQLError("PersistedQueryMismatch", {
            extensions: { code: "PERSISTED_QUERY_MISMATCH" },
          });
        }
        await redis.set(key, params.query, "EX", cfg.APQ_TTL_SECONDS);
        return;
      }

      const stored = await redis.get(key);
      if (!stored) {
        throw new GraphQLError("PersistedQueryNotFound", {
          extensions: { code: "PERSISTED_QUERY_NOT_FOUND" },
        });
      }
      setParams({ ...params, query: stored });
    },
  };
}

export async function warmApqDocuments(
  docs: Array<{ hash: string; query: string }>,
): Promise<void> {
  const cfg = loadConfig();
  const redis = getRedis();
  for (const doc of docs) {
    await redis.set(`apq:${doc.hash}`, doc.query, "EX", cfg.APQ_TTL_SECONDS);
  }
}

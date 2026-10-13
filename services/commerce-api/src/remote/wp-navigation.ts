/**
 * Forward `Query.navigation` to WordPress WPGraphQL via schema stitching, so any
 * ACF field added to the Navigation options page is queryable with no Commerce change.
 *
 * - Remote schema is introspected at startup and re-introspected periodically.
 * - Only `Query.navigation` (and types reachable from it) is taken from WP; remote type
 *   names that clash with local Commerce types are prefixed `Wp`.
 * - Stitching is only enabled when the remote Navigation is a superset (by field name,
 *   recursively) of the local one, so storefront queries never break validation
 *   (e.g. before WP PR #27 exposes termsOfService/privacyPolicy).
 * - At request time, if WP fails, falls back to the local DB reader (getNavigation).
 * - Responses are cached in Redis (short TTL) with an in-memory fallback.
 */
import { createHash } from "node:crypto";
import {
  getNamedType,
  isObjectType,
  print,
  type GraphQLNamedType,
  type GraphQLSchema,
} from "graphql";
import { stitchSchemas } from "@graphql-tools/stitch";
import { delegateToSchema, type SubschemaConfig } from "@graphql-tools/delegate";
import {
  FilterRootFields,
  RenameTypes,
  schemaFromExecutor,
} from "@graphql-tools/wrap";
import type { ExecutionRequest, ExecutionResult, Executor } from "@graphql-tools/utils";
import { loadConfig } from "../config.js";
import { getRedis } from "../redis/client.js";
import { logJson } from "../utils/index.js";

type Fetcher = typeof fetch;
type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

const memory = new Map<string, { v: string; exp: number }>();
export const memoryCache: Cache = {
  async get(k) {
    const e = memory.get(k);
    if (!e) return null;
    if (e.exp < Date.now()) {
      memory.delete(k);
      return null;
    }
    return e.v;
  },
  async set(k, v, ttl) {
    memory.set(k, { v, exp: Date.now() + ttl * 1000 });
  },
};

export const redisOrMemoryCache: Cache = {
  async get(k) {
    try {
      return await getRedis().get(k);
    } catch {
      return memoryCache.get(k);
    }
  },
  async set(k, v, ttl) {
    try {
      await getRedis().set(k, v, "EX", ttl);
    } catch {
      await memoryCache.set(k, v, ttl);
    }
  },
};

export function wpGraphqlEndpoint(): string {
  const cfg = loadConfig();
  return cfg.WORDPRESS_GRAPHQL_URL || `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/graphql`;
}

export function wpGraphqlOrigin(): string {
  const cfg = loadConfig();
  return (
    cfg.WORDPRESS_GRAPHQL_ORIGIN?.trim() ||
    cfg.corsOrigins.find((o) => o && o !== "*") ||
    ""
  );
}

export function createWpExecutor(opts: {
  url: string;
  origin?: string;
  timeoutMs: number;
  cache?: Cache;
  cacheTtlSeconds?: number;
  fetcher?: Fetcher;
}): Executor {
  const doFetch = opts.fetcher ?? fetch;
  return (async (req: ExecutionRequest): Promise<ExecutionResult> => {
    const query = print(req.document);
    const variables = req.variables ?? {};
    const isQuery = req.operationType !== "mutation" && req.operationType !== "subscription";
    const ttl = opts.cacheTtlSeconds ?? 0;
    const key = `wpgql:${createHash("sha256").update(query + JSON.stringify(variables)).digest("hex")}`;
    if (opts.cache && ttl > 0 && isQuery) {
      const hit = await opts.cache.get(key);
      if (hit) return JSON.parse(hit) as ExecutionResult;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.origin) {
      headers.Origin = opts.origin;
      headers.Referer = opts.origin.endsWith("/") ? opts.origin : `${opts.origin}/`;
    }
    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables, operationName: req.operationName }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const body = (await res.json()) as ExecutionResult;
    if (!res.ok && !body?.data) {
      throw new Error(`WP GraphQL ${res.status}: ${body?.errors?.[0]?.message ?? ""}`);
    }
    if (opts.cache && ttl > 0 && isQuery && body?.data && !body.errors?.length) {
      await opts.cache.set(key, JSON.stringify(body), ttl);
    }
    return body;
  }) as Executor;
}

/** Field-name tree of a type (cycle-safe), used for compatibility checks. */
function missingFields(
  local: GraphQLNamedType,
  remote: GraphQLNamedType,
  path: string,
  seen = new Set<string>(),
): string[] {
  if (!isObjectType(local) || !isObjectType(remote)) return [];
  const k = `${local.name}->${remote.name}`;
  if (seen.has(k)) return [];
  seen.add(k);
  const out: string[] = [];
  const rf = remote.getFields();
  for (const [name, f] of Object.entries(local.getFields())) {
    const r = rf[name];
    if (!r) {
      out.push(`${path}.${name}`);
      continue;
    }
    out.push(...missingFields(getNamedType(f.type), getNamedType(r.type), `${path}.${name}`, seen));
  }
  return out;
}

export function navigationCompatibility(local: GraphQLSchema, remote: GraphQLSchema): string[] {
  const l = local.getQueryType()?.getFields().navigation;
  const r = remote.getQueryType()?.getFields().navigation;
  if (!l) return [];
  if (!r) return ["Query.navigation"];
  return missingFields(getNamedType(l.type), getNamedType(r.type), "navigation");
}

/**
 * Build a schema where `Query.navigation` is served by WP (with DB fallback).
 * Returns null when the remote schema is unreachable or incompatible.
 */
export async function buildStitchedSchema(args: {
  local: GraphQLSchema;
  executor: Executor;
  fallbackNavigation: () => Promise<unknown>;
}): Promise<{ schema: GraphQLSchema } | { schema: null; reason: string }> {
  let remote: GraphQLSchema;
  try {
    remote = await schemaFromExecutor(args.executor);
  } catch (err) {
    return { schema: null, reason: `introspection_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const missing = navigationCompatibility(args.local, remote);
  if (missing.length) {
    return { schema: null, reason: `remote_navigation_missing: ${missing.slice(0, 10).join(", ")}` };
  }
  const localTypes = new Set(Object.keys(args.local.getTypeMap()));
  const builtin = new Set(["Query", "Mutation", "Subscription", "String", "Int", "Float", "Boolean", "ID"]);
  const wpSub: SubschemaConfig = {
    schema: remote,
    executor: args.executor,
    transforms: [
      new FilterRootFields((op, field) => op === "Query" && field === "navigation"),
      new RenameTypes((name) =>
        name.startsWith("__") || builtin.has(name) || !localTypes.has(name) ? name : `Wp${name}`,
      ),
    ],
  };
  const localSub: SubschemaConfig = {
    schema: args.local,
    transforms: [new FilterRootFields((op, field) => !(op === "Query" && field === "navigation"))],
  };
  const schema = stitchSchemas({
    subschemas: [localSub, wpSub],
    resolvers: {
      Query: {
        navigation: async (_root, _args, context, info) => {
          try {
            const result = await delegateToSchema({
              schema: wpSub,
              operation: "query" as never,
              fieldName: "navigation",
              context,
              info,
            });
            if (result instanceof Error || result == null) throw result ?? new Error("empty");
            return result;
          } catch (err) {
            logJson("warn", {
              msg: "wp_navigation_forward_failed_fallback_db",
              err: err instanceof Error ? err.message : String(err),
            });
            return args.fallbackNavigation();
          }
        },
      },
    },
  });
  return { schema };
}

/** Holds the current schema; re-introspects WP periodically. */
export async function createNavigationForwarding(opts: {
  local: GraphQLSchema;
  fallbackNavigation: () => Promise<unknown>;
}): Promise<{ current: () => GraphQLSchema; stop: () => void }> {
  const cfg = loadConfig();
  let current = opts.local;
  if (String(cfg.WP_GRAPHQL_FORWARD).toLowerCase() === "false") {
    logJson("info", { msg: "wp_navigation_forward_disabled" });
    return { current: () => current, stop: () => {} };
  }
  const executor = createWpExecutor({
    url: wpGraphqlEndpoint(),
    origin: wpGraphqlOrigin(),
    timeoutMs: cfg.WC_REST_TIMEOUT_MS,
    cache: redisOrMemoryCache,
    cacheTtlSeconds: cfg.WP_GRAPHQL_CACHE_TTL_SECONDS,
  });
  const refresh = async () => {
    const r = await buildStitchedSchema({ local: opts.local, executor, fallbackNavigation: opts.fallbackNavigation });
    if (r.schema) {
      current = r.schema;
      logJson("info", { msg: "wp_navigation_forward_enabled" });
    } else {
      // Keep the previous good schema on transient failures; local DB schema otherwise.
      logJson("warn", { msg: "wp_navigation_forward_unavailable", reason: r.reason });
    }
  };
  await refresh();
  const timer =
    cfg.WP_GRAPHQL_SCHEMA_REFRESH_MS > 0
      ? setInterval(() => void refresh().catch(() => {}), cfg.WP_GRAPHQL_SCHEMA_REFRESH_MS)
      : null;
  timer?.unref();
  return { current: () => current, stop: () => timer && clearInterval(timer) };
}

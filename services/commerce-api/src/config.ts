import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().default("wordpress"),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_DATABASE: z.string().default("wordpress"),
  MYSQL_TABLE_PREFIX: z.string().default("hy_"),
  MYSQL_POOL_SIZE: z.coerce.number().default(10),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  CART_TTL_SECONDS: z.coerce.number().default(604800),
  APQ_TTL_SECONDS: z.coerce.number().default(2592000),
  WORDPRESS_URL: z.string().default("http://localhost:8000"),
  /** Public uploads/CDN base (WP `S3_UPLOADS_BUCKET_URL`, e.g. https://img.mieland.com). */
  MEDIA_BASE_URL: z.string().default(""),
  WC_CONSUMER_KEY: z.string().default(""),
  WC_CONSUMER_SECRET: z.string().default(""),
  WC_REST_TIMEOUT_MS: z.coerce.number().default(15000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  JWT_SECRET: z.string().optional(),
  GRAPHQL_SECRET: z.string().optional(),
  MAX_BODY_BYTES: z.coerce.number().default(1_048_576),
  GRAPHQL_MAX_DEPTH: z.coerce.number().default(12),
  GRAPHQL_MAX_COMPLEXITY: z.coerce.number().default(500),
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().default(60),
  DISABLE_INTROSPECTION: boolFromEnv,
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProd: boolean;
  corsOrigins: string[];
  tablePrefix: string;
};

let cached: AppConfig | null = null;

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

/** Prefer WC_*; fall back to CONSUMER_* / camelCase aliases. */
function normalizeWcRestCredentials(): void {
  const key =
    process.env.WC_CONSUMER_KEY ||
    process.env.CONSUMER_KEY ||
    process.env.consumerKey ||
    "";
  const secret =
    process.env.WC_CONSUMER_SECRET ||
    process.env.CONSUMER_SECRET ||
    process.env.consumerSecret ||
    "";
  if (key) process.env.WC_CONSUMER_KEY = key;
  if (secret) process.env.WC_CONSUMER_SECRET = secret;
}

/** Prefer MEDIA_BASE_URL; accept WP S3 Uploads env name as alias. */
function normalizeMediaBaseUrl(): void {
  const media =
    process.env.MEDIA_BASE_URL || process.env.S3_UPLOADS_BUCKET_URL || "";
  if (media) process.env.MEDIA_BASE_URL = media;
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnv();
  normalizeWcRestCredentials();
  normalizeMediaBaseUrl();
  const parsed = envSchema.parse(process.env);
  cached = {
    ...parsed,
    isProd: parsed.NODE_ENV === "production",
    corsOrigins: parsed.CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tablePrefix: parsed.MYSQL_TABLE_PREFIX,
  };
  return cached;
}

export function t(name: string): string {
  return `${loadConfig().tablePrefix}${name}`;
}

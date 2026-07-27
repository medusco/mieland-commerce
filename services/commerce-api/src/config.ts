import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/** Railway/UI often sets env vars to "" — treat as unset so Zod defaults apply. */
const emptyToUndefined = (v: unknown) =>
  v === "" || v === null || v === undefined ? undefined : v;

const boolFromEnv = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
);

const envSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().default(4000)),
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "production", "test"]).default("development"),
  ),
  MYSQL_HOST: z.preprocess(
    emptyToUndefined,
    z.string().default("127.0.0.1"),
  ),
  MYSQL_PORT: z.preprocess(emptyToUndefined, z.coerce.number().default(3306)),
  MYSQL_USER: z.preprocess(emptyToUndefined, z.string().default("wordpress")),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_DATABASE: z.preprocess(
    emptyToUndefined,
    z.string().default("wordpress"),
  ),
  MYSQL_TABLE_PREFIX: z.preprocess(
    emptyToUndefined,
    z.string().default("hy_"),
  ),
  MYSQL_POOL_SIZE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(10),
  ),
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z.string().default("redis://127.0.0.1:6379"),
  ),
  CART_TTL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(604800),
  ),
  APQ_TTL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(2592000),
  ),
  WORDPRESS_URL: z.preprocess(
    emptyToUndefined,
    z.string().default("http://localhost:8000"),
  ),
  /** Public uploads/CDN base (WP `S3_UPLOADS_BUCKET_URL`, e.g. https://img.mieland.com). */
  MEDIA_BASE_URL: z.string().default(""),
  WC_CONSUMER_KEY: z.string().default(""),
  WC_CONSUMER_SECRET: z.string().default(""),
  WC_REST_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(15000),
  ),
  /** Store API POST /checkout/{id} (Stripe); longer than WC_REST_TIMEOUT_MS. */
  WC_STORE_PAYMENT_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(60_000),
  ),
  /** Personal one-time coupon issued via `requestPersonalCoupon`. */
  PERSONAL_COUPON_AMOUNT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(10),
  ),
  PERSONAL_COUPON_DISCOUNT_TYPE: z.preprocess(
    emptyToUndefined,
    z.enum(["percent", "fixed_cart", "fixed_product"]).default("percent"),
  ),
  PERSONAL_COUPON_CODE_PREFIX: z.preprocess(
    emptyToUndefined,
    z.string().default("MIELAND"),
  ),
  CORS_ORIGIN: z.preprocess(
    emptyToUndefined,
    z.string().default("http://localhost:3000,http://localhost:3001"),
  ),
  JWT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  GRAPHQL_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  MAX_BODY_BYTES: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(1_048_576),
  ),
  GRAPHQL_MAX_DEPTH: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(12),
  ),
  GRAPHQL_MAX_COMPLEXITY: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(500),
  ),
  CATALOG_CACHE_TTL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().default(60),
  ),
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
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    console.error(
      JSON.stringify({
        msg: "config_invalid",
        err: "Invalid environment configuration",
        details,
      }),
    );
    throw new Error(`Invalid environment configuration: ${details.join("; ")}`);
  }
  const parsed = result.data;
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

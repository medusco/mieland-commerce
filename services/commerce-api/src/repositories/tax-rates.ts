import { query, t } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";

export type WooTaxRateRow = {
  tax_rate_id: number;
  tax_rate_country: string;
  tax_rate_state: string;
  tax_rate: string;
  tax_rate_name: string;
  tax_rate_priority: number;
  tax_rate_compound: number;
  tax_rate_shipping: number;
  tax_rate_order: number;
  tax_rate_class: string;
};

export type WooTaxRateLocationRow = {
  location_id: number;
  location_code: string;
  tax_rate_id: number;
  location_type: string;
};

export type WooTaxRatesBundle = {
  rates: WooTaxRateRow[];
  locationsByRateId: Map<number, WooTaxRateLocationRow[]>;
};

function taxCacheKey(): string {
  const cfg = loadConfig();
  return `tax:${cfg.tablePrefix}:rates_v1`;
}

export async function loadWooTaxRatesBundle(): Promise<WooTaxRatesBundle> {
  const redis = getRedis();
  const cacheKey = taxCacheKey();
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as {
      rates: WooTaxRateRow[];
      locations: WooTaxRateLocationRow[];
    };
    const locationsByRateId = new Map<number, WooTaxRateLocationRow[]>();
    for (const loc of parsed.locations) {
      const bucket = locationsByRateId.get(loc.tax_rate_id) ?? [];
      bucket.push(loc);
      locationsByRateId.set(loc.tax_rate_id, bucket);
    }
    return { rates: parsed.rates, locationsByRateId };
  }

  const [rates, locations] = await Promise.all([
    query<WooTaxRateRow[]>(
      `SELECT tax_rate_id, tax_rate_country, tax_rate_state, tax_rate, tax_rate_name,
              tax_rate_priority, tax_rate_compound, tax_rate_shipping, tax_rate_order, tax_rate_class
       FROM ${t("woocommerce_tax_rates")}
       ORDER BY tax_rate_priority ASC, tax_rate_order ASC, tax_rate_id ASC`,
    ),
    query<WooTaxRateLocationRow[]>(
      `SELECT location_id, location_code, tax_rate_id, location_type
       FROM ${t("woocommerce_tax_rate_locations")}`,
    ),
  ]);

  const ttl = loadConfig().CATALOG_CACHE_TTL_SECONDS;
  await redis.set(
    cacheKey,
    JSON.stringify({ rates, locations }),
    "EX",
    ttl,
  );

  const locationsByRateId = new Map<number, WooTaxRateLocationRow[]>();
  for (const loc of locations) {
    const bucket = locationsByRateId.get(loc.tax_rate_id) ?? [];
    bucket.push(loc);
    locationsByRateId.set(loc.tax_rate_id, bucket);
  }
  return { rates, locationsByRateId };
}

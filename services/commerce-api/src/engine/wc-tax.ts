import type {
  CartTaxRequest,
  CartTaxResponse,
} from "../clients/mieland-wp-bridge.js";
import { query, t } from "../db/mysql.js";
import { getOptionString } from "../repositories/options.js";
import { getPostMetaKeysMany } from "../repositories/products.js";
import {
  loadWooTaxRatesBundle,
  type WooTaxRateLocationRow,
  type WooTaxRateRow,
} from "../repositories/tax-rates.js";
import { moneyStr, roundMoney } from "../utils/index.js";

export type MatchedTaxRate = {
  rateId: number;
  rate: number;
  label: string;
  shipping: boolean;
  compound: boolean;
};

const TAX_META_KEYS = ["_tax_class", "_tax_status"] as const;

/**
 * Check if a meta value is the WooCommerce "inherit from parent" sentinel.
 * WooCommerce uses "parent" as a literal string to indicate inheritance.
 */
function isInheritSentinel(value: string | undefined): boolean {
  if (!value) return true; // empty/undefined = inherit
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "parent";
}

/**
 * Resolve variation tax meta with parent inheritance.
 * WooCommerce variations use "_tax_class=parent" and empty to inherit from parent.
 */
function resolveInheritedMeta(
  variationValue: string | undefined,
  parentValue: string | undefined,
  defaultValue: string,
): string {
  if (isInheritSentinel(variationValue)) {
    return parentValue?.trim() || defaultValue;
  }
  return variationValue?.trim() || defaultValue;
}

export function sanitizeTaxClass(taxClass: string): string {
  const normalized = taxClass
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
  
  // WooCommerce: "standard" and "standard-rate" are aliases for "" (empty/default class).
  if (normalized === "standard" || normalized === "standard-rate") {
    return "";
  }
  
  return normalized;
}

export function normalizePostcode(postcode: string): string {
  return postcode.trim().toUpperCase().replace(/\s+/g, "");
}

/** Mirrors WooCommerce `wc_get_wildcard_postcodes` (prefix wildcards). */
export function wildcardPostcodes(postcode: string): string[] {
  const normalized = normalizePostcode(postcode);
  if (!normalized) return [""];
  const wildcards: string[] = [normalized];
  for (let i = 0; i < normalized.length; i++) {
    wildcards.push(`${normalized.slice(0, i + 1)}*`);
  }
  return [...new Set(wildcards)];
}

export function postcodeMatchesLocation(
  postcode: string,
  locationCode: string,
): boolean {
  const normalized = normalizePostcode(postcode);
  const loc = locationCode.trim().toUpperCase();
  if (!loc) return false;
  if (loc.includes("...")) {
    const [start, end] = loc.split("...");
    return normalized >= start && normalized <= end;
  }
  if (loc.endsWith("*")) {
    const prefix = loc.slice(0, -1);
    return normalized.startsWith(prefix);
  }
  const candidates = wildcardPostcodes(normalized);
  return candidates.includes(loc);
}

export function matchesTaxRateLocations(
  locations: WooTaxRateLocationRow[],
  postcode: string,
  city: string,
): boolean {
  const postcodes = locations.filter((l) => l.location_type === "postcode");
  const cities = locations.filter((l) => l.location_type === "city");
  if (!postcodes.length && !cities.length) return true;

  const cityUpper = city.trim().toUpperCase();

  if (postcodes.length) {
    const postcodeMatch = postcodes.some((l) =>
      postcodeMatchesLocation(postcode, l.location_code),
    );
    if (!postcodeMatch) return false;
    if (!cities.length) return true;
    return cities.some((l) => l.location_code.toUpperCase() === cityUpper);
  }

  return cities.some((l) => l.location_code.toUpperCase() === cityUpper);
}

function rateMatchesCountryState(
  rate: WooTaxRateRow,
  country: string,
  state: string,
): boolean {
  const c = country.toUpperCase();
  const s = state.toUpperCase();
  const rc = (rate.tax_rate_country || "").toUpperCase();
  const rs = (rate.tax_rate_state || "").toUpperCase();
  if (rc && rc !== c) return false;
  if (rs && rs !== s) return false;
  return true;
}

function sortRatesForMatch(rates: WooTaxRateRow[]): WooTaxRateRow[] {
  return [...rates].sort((a, b) => {
    if (a.tax_rate_priority !== b.tax_rate_priority) {
      return a.tax_rate_priority - b.tax_rate_priority;
    }
    const ac = (a.tax_rate_country || "").toUpperCase();
    const bc = (b.tax_rate_country || "").toUpperCase();
    if (ac !== bc) {
      if (!ac) return 1;
      if (!bc) return -1;
      return ac.localeCompare(bc);
    }
    const as = (a.tax_rate_state || "").toUpperCase();
    const bs = (b.tax_rate_state || "").toUpperCase();
    if (as !== bs) {
      if (!as) return 1;
      if (!bs) return -1;
      return as.localeCompare(bs);
    }
    return a.tax_rate_id - b.tax_rate_id;
  });
}

export function findMatchedTaxRates(
  bundle: {
    rates: WooTaxRateRow[];
    locationsByRateId: Map<number, WooTaxRateLocationRow[]>;
  },
  args: {
    country: string;
    state: string;
    postcode: string;
    city: string;
    taxClass: string;
  },
): MatchedTaxRate[] {
  const country = args.country.trim().toUpperCase();
  if (!country) return [];

  const taxClass = sanitizeTaxClass(args.taxClass);
  const state = args.state.trim().toUpperCase();
  const postcode = args.postcode ?? "";
  const city = args.city ?? "";

  const candidates = bundle.rates.filter((rate) => {
    if (sanitizeTaxClass(rate.tax_rate_class || "") !== taxClass) return false;
    if (!rateMatchesCountryState(rate, country, state)) return false;
    const locations = bundle.locationsByRateId.get(rate.tax_rate_id) ?? [];
    return matchesTaxRateLocations(locations, postcode, city);
  });

  const sorted = sortRatesForMatch(candidates);
  const matched: MatchedTaxRate[] = [];
  const seenPriority = new Set<number>();

  for (const rate of sorted) {
    if (seenPriority.has(rate.tax_rate_priority)) continue;
    seenPriority.add(rate.tax_rate_priority);
    matched.push({
      rateId: rate.tax_rate_id,
      rate: Number(rate.tax_rate) || 0,
      label: rate.tax_rate_name,
      shipping: Boolean(rate.tax_rate_shipping),
      compound: Boolean(rate.tax_rate_compound),
    });
  }

  return matched;
}

/** WooCommerce `WC_Tax::calc_exclusive_tax` (2dp cart rounding). */
export function calcExclusiveTax(
  price: number,
  rates: MatchedTaxRate[],
): Map<number, number> {
  const taxes = new Map<number, number>();
  const base = Number(price) || 0;
  if (!rates.length || base <= 0) return taxes;

  for (const rate of rates) {
    if (rate.compound) continue;
    const amount = roundMoney(base * (rate.rate / 100));
    taxes.set(rate.rateId, (taxes.get(rate.rateId) ?? 0) + amount);
  }

  let compoundBase = base;
  for (const [, amount] of taxes) {
    compoundBase = roundMoney(compoundBase + amount);
  }

  for (const rate of rates) {
    if (!rate.compound) continue;
    const amount = roundMoney(compoundBase * (rate.rate / 100));
    taxes.set(rate.rateId, (taxes.get(rate.rateId) ?? 0) + amount);
    compoundBase = roundMoney(compoundBase + amount);
  }

  return taxes;
}

function mergeTaxMaps(target: Map<number, number>, add: Map<number, number>): void {
  for (const [id, amount] of add) {
    target.set(id, roundMoney((target.get(id) ?? 0) + amount));
  }
}

async function loadProductTitles(
  productIds: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(productIds.filter((id) => id > 0))];
  const out = new Map<number, string>();
  if (!unique.length) return out;
  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<{ ID: number; post_title: string }[]>(
    `SELECT ID, post_title FROM ${t("posts")} WHERE ID IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    out.set(row.ID, row.post_title);
  }
  return out;
}

async function shippingTaxClassSlug(): Promise<string> {
  const raw = await getOptionString("woocommerce_shipping_tax_class", "");
  if (!raw || raw === "inherit") return "";
  return sanitizeTaxClass(raw);
}

export async function calculateWooCommerceCartTax(
  body: CartTaxRequest,
): Promise<CartTaxResponse> {
  const calcTaxes = await getOptionString("woocommerce_calc_taxes", "no");
  const currency = await getOptionString("woocommerce_currency", "USD");
  const shippingCost = roundMoney(Number(body.shipping?.cost ?? 0) || 0);

  let subtotalNum = 0;
  for (const item of body.items) {
    subtotalNum = roundMoney(
      subtotalNum + roundMoney((item.unitPrice ?? 0) * item.quantity),
    );
  }

  if (calcTaxes !== "yes") {
    const total = roundMoney(subtotalNum + shippingCost);
    return {
      success: true,
      provider: "woocommerce",
      taxTotal: "0.00",
      contentsTax: "0.00",
      shippingTax: "0.00",
      feeTax: "0.00",
      subtotal: moneyStr(subtotalNum),
      shippingTotal: moneyStr(shippingCost),
      total: moneyStr(total),
      currency,
      message: "OK — taxes disabled in WooCommerce settings",
      taxTotals: [],
      items: [],
    };
  }

  const country = body.address.country?.trim() ?? "";
  if (!country) {
    return {
      success: false,
      provider: "woocommerce",
      message: "Country is required for tax calculation",
      taxTotal: "0.00",
      contentsTax: "0.00",
      shippingTax: "0.00",
      feeTax: "0.00",
      subtotal: moneyStr(subtotalNum),
      shippingTotal: moneyStr(shippingCost),
      total: moneyStr(subtotalNum + shippingCost),
      currency,
      taxTotals: [],
      items: [],
    };
  }

  const bundle = await loadWooTaxRatesBundle();
  const locationArgs = {
    country,
    state: body.address.state ?? "",
    postcode: body.address.postcode ?? "",
    city: body.address.city ?? "",
  };

  // Load meta for both variations and parent products to support WooCommerce inheritance.
  const allProductIds = new Set<number>();
  for (const item of body.items) {
    allProductIds.add(item.productId);
    if (item.variationId) allProductIds.add(item.variationId);
  }
  const [metaMap, titles] = await Promise.all([
    getPostMetaKeysMany([...allProductIds], [...TAX_META_KEYS]),
    loadProductTitles([...allProductIds]),
  ]);

  const taxByRateId = new Map<number, number>();
  const labelByRateId = new Map<number, string>();
  let contentsTax = 0;
  const itemsOut: CartTaxResponse["items"] = [];

  for (const item of body.items) {
    const variationMeta = item.variationId
      ? metaMap.get(item.variationId) ?? {}
      : {};
    const parentMeta = metaMap.get(item.productId) ?? {};
    
    // WooCommerce variations inherit tax settings from parent.
    // Empty/"" and literal string "parent" both mean inherit.
    const taxStatus = resolveInheritedMeta(
      variationMeta._tax_status,
      parentMeta._tax_status,
      "taxable",
    ).toLowerCase();
    
    // Resolve tax class with inheritance, then apply standard→'' alias.
    // WooCommerce: empty/"parent" = inherit; "standard"/"standard-rate" = "".
    const rawTaxClass = resolveInheritedMeta(
      variationMeta._tax_class,
      parentMeta._tax_class,
      "",
    );
    const taxClass = sanitizeTaxClass(rawTaxClass);
    
    const lineTotal = roundMoney((item.unitPrice ?? 0) * item.quantity);
    let lineTax = 0;

    if (taxStatus === "taxable" && lineTotal > 0) {
      const rates = findMatchedTaxRates(bundle, {
        ...locationArgs,
        taxClass,
      });
      for (const rate of rates) {
        labelByRateId.set(rate.rateId, rate.label);
      }
      const lineTaxes = calcExclusiveTax(lineTotal, rates);
      mergeTaxMaps(taxByRateId, lineTaxes);
      for (const amount of lineTaxes.values()) {
        lineTax = roundMoney(lineTax + amount);
      }
    }

    contentsTax = roundMoney(contentsTax + lineTax);
    const displayId = item.variationId || item.productId;
    itemsOut.push({
      productId: item.productId,
      variationId: item.variationId ?? 0,
      quantity: item.quantity,
      lineTotal: moneyStr(lineTotal),
      lineTax: moneyStr(lineTax),
      name: titles.get(displayId) ?? "",
      taxStatus,
      taxClass,
    });
  }

  // Shipping tax is data-driven: only rates with tax_rate_shipping=1 apply to shipping cost.
  // contentsTax is the sum of line taxes only; shippingTax is calculated separately.
  let shippingTax = 0;
  if (shippingCost > 0) {
    const shipClass = await shippingTaxClassSlug();
    const shipRates = findMatchedTaxRates(bundle, {
      ...locationArgs,
      taxClass: shipClass,
    }).filter((r) => r.shipping);
    for (const rate of shipRates) {
      labelByRateId.set(rate.rateId, rate.label);
    }
    const shipTaxes = calcExclusiveTax(shippingCost, shipRates);
    mergeTaxMaps(taxByRateId, shipTaxes);
    for (const amount of shipTaxes.values()) {
      shippingTax = roundMoney(shippingTax + amount);
    }
  }

  const taxTotal = roundMoney(contentsTax + shippingTax);
  const taxTotals = [...taxByRateId.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([rateId, amount]) => ({
      code: `tax_rate_${rateId}`,
      label: labelByRateId.get(rateId) ?? `Tax ${rateId}`,
      amount: moneyStr(amount),
    }));

  const total = roundMoney(subtotalNum + shippingCost + taxTotal);

  return {
    success: true,
    provider: "woocommerce",
    taxTotal: moneyStr(taxTotal),
    contentsTax: moneyStr(contentsTax),
    shippingTax: moneyStr(shippingTax),
    feeTax: "0.00",
    subtotal: moneyStr(subtotalNum),
    shippingTotal: moneyStr(shippingCost),
    total: moneyStr(total),
    currency,
    message: `OK — taxTotal ${moneyStr(taxTotal)} via woocommerce`,
    taxTotals,
    items: itemsOut,
  };
}

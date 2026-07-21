import { query, queryOne, t } from "../db/mysql.js";
import { getOption } from "../repositories/options.js";
import type { CartAddress, CartState } from "./types.js";
import { roundMoney } from "../utils/index.js";

export type ShippingRate = {
  id: string;
  instanceId: number;
  label: string;
  methodId: string;
  cost: string;
};

export type ShippingPackage = {
  packageDetails: string;
  rates: ShippingRate[];
};

type ZoneMethod = {
  zone_id: number;
  instance_id: number;
  method_id: string;
  method_order: number;
  is_enabled: number;
};

async function loadZoneLocations(): Promise<
  Array<{ zone_id: number; location_code: string; location_type: string }>
> {
  return query(
    `SELECT zone_id, location_code, location_type FROM ${t("woocommerce_shipping_zone_locations")}`,
  );
}

async function loadZones(): Promise<
  Array<{ zone_id: number; zone_name: string; zone_order: number }>
> {
  return query(
    `SELECT zone_id, zone_name, zone_order FROM ${t("woocommerce_shipping_zones")} ORDER BY zone_order ASC`,
  );
}

async function loadMethods(): Promise<ZoneMethod[]> {
  return query(
    `SELECT zone_id, instance_id, method_id, method_order, is_enabled
     FROM ${t("woocommerce_shipping_zone_methods")}
     WHERE is_enabled = 1
     ORDER BY method_order ASC`,
  );
}

function countryMatches(
  country: string,
  locations: Array<{ location_code: string; location_type: string }>,
): boolean {
  if (locations.length === 0) return true; // rest of world / empty
  const c = country.toUpperCase();
  for (const loc of locations) {
    if (loc.location_type === "country" && loc.location_code.toUpperCase() === c) {
      return true;
    }
    if (loc.location_type === "continent") {
      // minimal: treat as match if code equals (WC continents are like NA, EU)
      if (loc.location_code) return true;
    }
  }
  return false;
}

async function methodSettings(
  methodId: string,
  instanceId: number,
): Promise<Record<string, string>> {
  const optName = `woocommerce_${methodId}_${instanceId}_settings`;
  const raw = await getOption<Record<string, string>>(optName);
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = String(v ?? "");
    return out;
  }
  return {};
}

function rateCost(
  methodId: string,
  settings: Record<string, string>,
  subtotal: number,
): number | null {
  if (methodId === "free_shipping") {
    const requires = settings.requires ?? "";
    const minAmount = Number(settings.min_amount ?? 0);
    if (requires === "min_amount" || requires === "either" || requires === "both") {
      if (subtotal < minAmount) return null;
    }
    if (requires === "" || requires === "coupon") {
      // coupon-only free shipping not fully modeled; allow if no min
      if (minAmount > 0 && subtotal < minAmount && requires !== "") return null;
    }
    return 0;
  }
  if (methodId === "flat_rate") {
    return roundMoney(Number(settings.cost ?? 0));
  }
  // Unknown methods (e.g. MCF) skipped until present in zones
  return null;
}

export async function resolveShipping(
  cart: CartState,
  subtotalAfterDiscount: number,
): Promise<{ packages: ShippingPackage[]; chosenCost: number; chosenIds: string[] }> {
  const country =
    (cart.shipping.country || cart.billing.country || "").toUpperCase();
  if (!country) {
    return { packages: [], chosenCost: 0, chosenIds: [] };
  }

  const [zones, locations, methods] = await Promise.all([
    loadZones(),
    loadZoneLocations(),
    loadMethods(),
  ]);

  const locsByZone = new Map<number, typeof locations>();
  for (const loc of locations) {
    const list = locsByZone.get(loc.zone_id) ?? [];
    list.push(loc);
    locsByZone.set(loc.zone_id, list);
  }

  let matchedZoneId: number | null = null;
  for (const zone of zones) {
    const locs = locsByZone.get(zone.zone_id) ?? [];
    if (locs.length === 0) {
      // catch-all zone (no locations) — keep as fallback
      if (matchedZoneId == null) matchedZoneId = zone.zone_id;
      continue;
    }
    if (countryMatches(country, locs)) {
      matchedZoneId = zone.zone_id;
      break;
    }
  }

  // Prefer explicit country match over empty catch-all
  for (const zone of zones) {
    const locs = locsByZone.get(zone.zone_id) ?? [];
    if (locs.length > 0 && countryMatches(country, locs)) {
      matchedZoneId = zone.zone_id;
      break;
    }
  }

  if (matchedZoneId == null && zones.length) {
    const catchAll = zones.find((z) => (locsByZone.get(z.zone_id) ?? []).length === 0);
    matchedZoneId = catchAll?.zone_id ?? zones[zones.length - 1]!.zone_id;
  }

  const zoneMethods = methods.filter((m) => m.zone_id === matchedZoneId);
  const rates: ShippingRate[] = [];
  for (const m of zoneMethods) {
    const settings = await methodSettings(m.method_id, m.instance_id);
    const cost = rateCost(m.method_id, settings, subtotalAfterDiscount);
    if (cost == null) continue;
    const label = settings.title || m.method_id;
    rates.push({
      id: `${m.method_id}:${m.instance_id}`,
      instanceId: m.instance_id,
      label,
      methodId: m.method_id,
      cost: cost.toFixed(2),
    });
  }

  const packages: ShippingPackage[] = [
    {
      packageDetails: "Shipment 1",
      rates,
    },
  ];

  let chosenIds = cart.chosenShippingMethods.filter((id) =>
    rates.some((r) => r.id === id),
  );
  if (!chosenIds.length && rates.length) {
    chosenIds = [rates[0]!.id];
  }

  const chosenCost = chosenIds.reduce((sum, id) => {
    const rate = rates.find((r) => r.id === id);
    return sum + Number(rate?.cost ?? 0);
  }, 0);

  return {
    packages,
    chosenCost: roundMoney(chosenCost),
    chosenIds,
  };
}

export function addressFromCustomerMeta(
  meta: Record<string, string>,
  prefix: "billing" | "shipping",
): CartAddress {
  return {
    firstName: meta[`${prefix}_first_name`] ?? "",
    lastName: meta[`${prefix}_last_name`] ?? "",
    company: meta[`${prefix}_company`] ?? "",
    address1: meta[`${prefix}_address_1`] ?? "",
    address2: meta[`${prefix}_address_2`] ?? "",
    city: meta[`${prefix}_city`] ?? "",
    state: meta[`${prefix}_state`] ?? "",
    postcode: meta[`${prefix}_postcode`] ?? "",
    country: meta[`${prefix}_country`] ?? "",
    phone: meta[`${prefix}_phone`] ?? "",
    email: meta[`${prefix}_email`] ?? "",
  };
}

export async function getUserAddressMeta(
  userId: number,
): Promise<Record<string, string>> {
  const rows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("usermeta")} WHERE user_id = ?`,
    [userId],
  );
  return Object.fromEntries(rows.map((r) => [r.meta_key, r.meta_value ?? ""]));
}

export async function loadCoupon(code: string): Promise<{
  id: number;
  code: string;
  description: string;
  discountType: string;
  amount: number;
  freeShipping: boolean;
} | null> {
  const post = await queryOne<{ ID: number; post_excerpt: string }>(
    `SELECT ID, post_excerpt FROM ${t("posts")}
     WHERE post_type = 'shop_coupon' AND post_status = 'publish' AND post_title = ?
     LIMIT 1`,
    [code],
  );
  if (!post) return null;
  const metaRows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ?`,
    [post.ID],
  );
  const meta = Object.fromEntries(metaRows.map((r) => [r.meta_key, r.meta_value]));
  return {
    id: post.ID,
    code,
    description: post.post_excerpt ?? "",
    discountType: meta.discount_type ?? "fixed_cart",
    amount: Number(meta.coupon_amount ?? 0),
    freeShipping: meta.free_shipping === "yes",
  };
}

export function applyCoupons(
  subtotal: number,
  coupons: Array<{ discountType: string; amount: number; code: string; description: string }>,
): { discountTotal: number; applied: Array<{ code: string; description: string; discountAmount: string; discountTax: string }> } {
  let remaining = subtotal;
  let discountTotal = 0;
  const applied = [];
  for (const c of coupons) {
    let d = 0;
    if (c.discountType === "percent") {
      d = roundMoney(remaining * (c.amount / 100));
    } else if (c.discountType === "fixed_cart" || c.discountType === "fixed_product") {
      d = roundMoney(Math.min(remaining, c.amount));
    }
    discountTotal = roundMoney(discountTotal + d);
    remaining = roundMoney(Math.max(0, remaining - d));
    applied.push({
      code: c.code,
      description: c.description,
      discountAmount: d.toFixed(2),
      discountTax: "0.00",
    });
  }
  return { discountTotal, applied };
}

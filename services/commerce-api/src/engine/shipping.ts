import { query, queryOne, t } from "../db/mysql.js";
import { getOption, maybeUnserializePhp } from "../repositories/options.js";
import type { CartAddress, CartState } from "./types.js";
import { getItemFrequency, isValidFrequency } from "./types.js";
import { roundMoney } from "../utils/index.js";
import {
  isCouponUsageExhausted,
  parseCouponUsageCount,
  parseCouponUsageLimit,
  parseIsPersonalizedCoupon,
} from "./coupon-meta.js";

export type ShippingRate = {
  id: string;
  instanceId: number;
  label: string;
  methodId: string;
  cost: string;
  /** WP instance setting checkbox `expedited` (mieland-shipping-expedited). */
  isExpedited: boolean;
};

/** Match WP `mieland_shipping_expedited_is_yes`. */
function isExpeditedSetting(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

export type ShippingPackage = {
  packageDetails: string;
  rates: ShippingRate[];
};

export type FreeShippingInfo = {
  methodId: string;
  instanceId: number;
  label: string;
  /** WooCommerce requires: '', coupon, min_amount, either, both */
  requires: string;
  minAmount: string;
  /** Whether the cart currently qualifies for this free shipping method */
  eligible: boolean;
  /** How much cart subtotal (pre-coupon) is still needed; 0 when eligible or no min */
  amountRemaining: string;
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
  /** Subscription carts always unlock Woo free_shipping methods. */
  forceFreeShipping = false,
): number | null {
  if (methodId === "free_shipping") {
    if (forceFreeShipping) return 0;
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

function cartHasSubscription(cart: CartState): boolean {
  return cart.items.some((item) => isValidFrequency(getItemFrequency(item)));
}

/** US-only storefront: zone lookup when cart has no address yet (cart drawer, guest). */
const DEFAULT_SHIPPING_COUNTRY = "US";

export async function resolveShipping(
  cart: CartState,
  /** Cart subtotal before coupons; used for free_shipping min_amount checks. */
  subtotal: number,
): Promise<{
  packages: ShippingPackage[];
  chosenCost: number;
  chosenIds: string[];
  freeShippingInfo: FreeShippingInfo | null;
}> {
  const country = (
    cart.shipping.country ||
    cart.billing.country ||
    DEFAULT_SHIPPING_COUNTRY
  ).toUpperCase();

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
  let freeShippingInfo: FreeShippingInfo | null = null;
  const forceFreeShipping = cartHasSubscription(cart);

  for (const m of zoneMethods) {
    const settings = await methodSettings(m.method_id, m.instance_id);
    const cost = rateCost(m.method_id, settings, subtotal, forceFreeShipping);

    if (m.method_id === "free_shipping" && freeShippingInfo == null) {
      const minAmount = Number(settings.min_amount ?? 0);
      const requires = settings.requires ?? "";
      const minApplies =
        !forceFreeShipping &&
        (requires === "min_amount" ||
          requires === "either" ||
          requires === "both" ||
          (requires === "coupon" && minAmount > 0));
      const remaining = minApplies
        ? roundMoney(Math.max(0, minAmount - subtotal))
        : 0;
      freeShippingInfo = {
        methodId: m.method_id,
        instanceId: m.instance_id,
        label: settings.title || m.method_id,
        requires,
        minAmount: minAmount.toFixed(2),
        eligible: cost != null,
        amountRemaining: remaining.toFixed(2),
      };
    }

    if (cost == null) continue;
    const label = settings.title || m.method_id;
    rates.push({
      id: `${m.method_id}:${m.instance_id}`,
      instanceId: m.instance_id,
      label,
      methodId: m.method_id,
      cost: cost.toFixed(2),
      isExpedited: isExpeditedSetting(settings.expedited),
    });
  }

  // Subscription carts always get free shipping, even if the zone has no
  // free_shipping method (or min_amount would otherwise block it).
  if (forceFreeShipping && !rates.some((r) => Number(r.cost) === 0)) {
    rates.push({
      id: "free_shipping:subscription",
      instanceId: 0,
      label: "Free shipping",
      methodId: "free_shipping",
      cost: "0.00",
      isExpedited: false,
    });
  }
  if (forceFreeShipping) {
    if (freeShippingInfo) {
      freeShippingInfo = {
        ...freeShippingInfo,
        eligible: true,
        amountRemaining: "0.00",
      };
    } else {
      freeShippingInfo = {
        methodId: "free_shipping",
        instanceId: 0,
        label: "Free shipping",
        requires: "",
        minAmount: "0.00",
        eligible: true,
        amountRemaining: "0.00",
      };
    }
  }

  // When free shipping is available, offer free rates plus Expedited methods
  // (WP checkbox) so customers can upgrade; hide other paid non-expedited rates.
  // Subscription carts force free shipping and cannot use expedited delivery.
  const freeRates = rates.filter((r) => Number(r.cost) === 0);
  const existingChosen = cart.chosenShippingMethods.filter((id) =>
    rates.some((r) => r.id === id),
  );
  const availableRates =
    freeRates.length > 0
      ? [
          ...freeRates,
          ...(forceFreeShipping
            ? []
            : rates.filter((r) => r.isExpedited && Number(r.cost) !== 0)),
        ]
      : forceFreeShipping
        ? rates.filter((r) => !r.isExpedited)
        : rates;

  const packages: ShippingPackage[] = [
    {
      packageDetails: "Shipment 1",
      rates: availableRates,
    },
  ];

  let chosenIds = existingChosen.filter((id) =>
    availableRates.some((r) => r.id === id),
  );
  if (!chosenIds.length) {
    if (freeRates.length > 0) {
      chosenIds = [freeRates[0]!.id];
    } else if (availableRates.length) {
      chosenIds = [availableRates[0]!.id];
    }
  }

  const chosenCost = chosenIds.reduce((sum, id) => {
    const rate = availableRates.find((r) => r.id === id);
    return sum + Number(rate?.cost ?? 0);
  }, 0);

  return {
    packages,
    chosenCost: roundMoney(chosenCost),
    chosenIds,
    freeShippingInfo,
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

export type LoadedCoupon = {
  id: number;
  code: string;
  description: string;
  discountType: string;
  amount: number;
  freeShipping: boolean;
  /** Template coupons flagged in Woo admin — not directly applicable at checkout. */
  isPersonalized: boolean;
  /** Lowercased emails from WC `customer_email` / email_restrictions. Empty = unrestricted. */
  emailRestrictions: string[];
  /** Woo `usage_count` — times this coupon has been redeemed. */
  usageCount: number;
  /** Woo `usage_limit` — null means unlimited. */
  usageLimit: number | null;
};

/** Parse WooCommerce coupon email_restrictions (`customer_email` postmeta). */
export function parseCouponEmailRestrictions(
  raw: string | undefined | null,
): string[] {
  if (!raw?.trim()) return [];
  const parsed = maybeUnserializePhp(raw.trim());
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "string"
      ? parsed.split(/[\s,;]+/)
      : [];
  return [
    ...new Set(
      list
        .map((e) => String(e ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@")),
    ),
  ];
}

export function normalizeApplicantEmails(
  emails: Array<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      emails
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@")),
    ),
  ];
}

/**
 * Whether a coupon may be used by any of the applicant emails.
 * Unrestricted coupons always pass. Restricted coupons require at least one match.
 */
export function couponAllowsEmails(
  coupon: Pick<LoadedCoupon, "emailRestrictions">,
  applicantEmails: string[],
): boolean {
  if (!coupon.emailRestrictions.length) return true;
  if (!applicantEmails.length) return false;
  const allowed = new Set(coupon.emailRestrictions);
  return applicantEmails.some((e) => allowed.has(e));
}

export function assertCouponEmailAllowed(
  coupon: Pick<LoadedCoupon, "emailRestrictions" | "code">,
  applicantEmails: string[],
): void {
  if (!coupon.emailRestrictions.length) return;
  if (!applicantEmails.length) {
    throw new Error(
      "This coupon is restricted to a specific email address. Add a billing email to checkout.",
    );
  }
  if (!couponAllowsEmails(coupon, applicantEmails)) {
    throw new Error("This coupon cannot be used with your email address.");
  }
}

export function assertCouponApplicable(
  coupon: Pick<
    LoadedCoupon,
    "code" | "isPersonalized" | "usageCount" | "usageLimit"
  >,
): void {
  if (coupon.isPersonalized) {
    throw new Error(
      "This coupon cannot be applied directly. Use the code sent to your email after signing up.",
    );
  }
  if (isCouponUsageExhausted(coupon.usageCount, coupon.usageLimit)) {
    throw new Error("This coupon has already been used.");
  }
}

export { isCouponUsageExhausted };

export async function loadCoupon(code: string): Promise<LoadedCoupon | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const post = await queryOne<{
    ID: number;
    post_excerpt: string;
    post_title: string;
  }>(
    `SELECT ID, post_excerpt, post_title FROM ${t("posts")}
     WHERE post_type = 'shop_coupon' AND post_status = 'publish'
       AND UPPER(post_title) = ?
     LIMIT 1`,
    [normalized],
  );
  if (!post) return null;
  const metaRows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ?`,
    [post.ID],
  );
  const meta = Object.fromEntries(metaRows.map((r) => [r.meta_key, r.meta_value]));
  let emailRestrictions = parseCouponEmailRestrictions(meta.customer_email);
  // Fallback for personal coupons if WC meta is missing but our marker exists.
  if (!emailRestrictions.length && meta.mieland_personal_coupon_email) {
    emailRestrictions = parseCouponEmailRestrictions(
      meta.mieland_personal_coupon_email,
    );
  }
  return {
    id: post.ID,
    code: (post.post_title || normalized).trim().toUpperCase(),
    description: post.post_excerpt ?? "",
    discountType: meta.discount_type ?? "fixed_cart",
    amount: Number(meta.coupon_amount ?? 0),
    freeShipping: meta.free_shipping === "yes",
    isPersonalized: parseIsPersonalizedCoupon(meta),
    emailRestrictions,
    usageCount: parseCouponUsageCount(meta.usage_count),
    usageLimit: parseCouponUsageLimit(meta.usage_limit),
  };
}

export type CouponCartLine = {
  quantity: number;
  unitPrice: number;
};

export function applyCoupons(
  subtotal: number,
  coupons: Array<{ discountType: string; amount: number; code: string; description: string }>,
  lines: CouponCartLine[] = [],
): { discountTotal: number; applied: Array<{ code: string; description: string; discountAmount: string; discountTax: string; discountType: string; amount: string }> } {
  let remaining = subtotal;
  let discountTotal = 0;
  const applied = [];
  for (const c of coupons) {
    let d = 0;
    if (c.discountType === "percent") {
      d = roundMoney(remaining * (c.amount / 100));
    } else if (c.discountType === "fixed_cart") {
      d = roundMoney(Math.min(remaining, c.amount));
    } else if (c.discountType === "fixed_product") {
      // WooCommerce: fixed amount off each matching unit (all lines here).
      let productDiscount = 0;
      for (const line of lines) {
        const perUnit = Math.min(c.amount, line.unitPrice);
        productDiscount = roundMoney(
          productDiscount + perUnit * line.quantity,
        );
      }
      d = roundMoney(Math.min(remaining, productDiscount));
    }
    discountTotal = roundMoney(discountTotal + d);
    remaining = roundMoney(Math.max(0, remaining - d));
    applied.push({
      code: c.code,
      description: c.description,
      discountAmount: d.toFixed(2),
      discountTax: "0.00",
      discountType: c.discountType,
      amount: String(c.amount),
    });
  }
  return { discountTotal, applied };
}

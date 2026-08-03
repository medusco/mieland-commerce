import { getOption } from "../repositories/options.js";
import { FREQUENCIES, getItemFrequency, isValidFrequency, type CartItem } from "./types.js";
import { moneyStr, roundMoney } from "../utils/index.js";

export async function getSubscriptionDiscounts(): Promise<
  Record<string, number>
> {
  const stored = await getOption<Record<string, number>>(
    "mieland_subscriptions_discounts",
  );
  const defaults: Record<string, number> = {};
  for (const f of FREQUENCIES) defaults[f] = 0;
  if (!stored || typeof stored !== "object") return defaults;
  for (const f of FREQUENCIES) {
    const v = Number(stored[f] ?? 0);
    defaults[f] = Math.min(100, Math.max(0, Math.round(v * 100) / 100));
  }
  return defaults;
}

export function applyFrequencyDiscount(
  unitPrice: number,
  frequency: string,
  discounts: Record<string, number>,
): number {
  if (!frequency || !isValidFrequency(frequency) || unitPrice <= 0) {
    return roundMoney(unitPrice);
  }
  const discount = discounts[frequency] ?? 0;
  if (discount <= 0) return roundMoney(unitPrice);
  return roundMoney(unitPrice * (1 - discount / 100));
}

export function lineUnitPrice(
  basePrice: number,
  item: CartItem,
  discounts: Record<string, number>,
): number {
  return applyFrequencyDiscount(basePrice, getItemFrequency(item), discounts);
}

/** Combined multiplier from sequential percent coupons (e.g. 10% + 10% → 0.81). */
export function percentCouponMultiplier(
  coupons: Array<{ discountType: string; amount: number }>,
): number {
  return coupons.reduce((multiplier, coupon) => {
    if (coupon.discountType !== "percent" || coupon.amount <= 0) {
      return multiplier;
    }
    const pct = Math.min(100, coupon.amount);
    return multiplier * (1 - pct / 100);
  }, 1);
}

export function applyPercentCouponToUnitPrice(
  unitPrice: number,
  coupons: Array<{ discountType: string; amount: number }>,
): number {
  const multiplier = percentCouponMultiplier(coupons);
  if (multiplier >= 1) return roundMoney(unitPrice);
  return roundMoney(unitPrice * multiplier);
}

type PricedProductNode = {
  price?: string | null;
  salePrice?: string | null;
  onSale?: boolean | null;
  [key: string]: unknown;
};

type CartDisplayPriceOptions = {
  /** Set salePrice even when the catalog item is not on sale (e.g. percent coupon). */
  forceSalePrice?: boolean;
};

/**
 * Clone a cart-line product/variation node so `price` / promo `salePrice`
 * reflect the cart unit price (subscription and/or percent-coupon discounts).
 * Leaves catalog nodes in the DataLoader cache untouched.
 */
export function withCartSubscriptionDisplayPrices<T extends PricedProductNode>(
  node: T,
  unitPrice: number,
  options: CartDisplayPriceOptions = {},
): T {
  if (!(unitPrice > 0)) return node;
  const money = moneyStr(unitPrice);
  const onSale =
    Boolean(options.forceSalePrice) ||
    Boolean(node.onSale) ||
    Boolean(node.salePrice);
  return {
    ...node,
    price: money,
    ...(onSale ? { salePrice: money } : {}),
  };
}

export type { PricedProductNode };

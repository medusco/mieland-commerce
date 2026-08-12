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

/**
 * Apply subscription frequency % off. Always pass the catalog regular price —
 * never the sale price.
 */
export function applyFrequencyDiscount(
  regularPrice: number,
  frequency: string,
  discounts: Record<string, number>,
): number {
  if (!frequency || !isValidFrequency(frequency) || regularPrice <= 0) {
    return roundMoney(regularPrice);
  }
  const discount = discounts[frequency] ?? 0;
  if (discount <= 0) return roundMoney(regularPrice);
  return roundMoney(regularPrice * (1 - discount / 100));
}

/**
 * Unit price after subscription discount from regular.
 * Callers should then {@link chooseBestUnitPrice} against catalog sale.
 */
export function lineUnitPrice(
  regularPrice: number,
  item: CartItem,
  discounts: Record<string, number>,
): number {
  return applyFrequencyDiscount(regularPrice, getItemFrequency(item), discounts);
}

/**
 * Prefer catalog sale when it beats the price after discounts from regular.
 * `discountedFromRegular` is subscription and/or percent-coupon off regular.
 */
export function chooseBestUnitPrice(
  discountedFromRegular: number,
  salePrice: number | null | undefined,
): number {
  const discounted = roundMoney(discountedFromRegular);
  if (!(salePrice != null && salePrice > 0)) return discounted;
  return roundMoney(Math.min(discounted, salePrice));
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

/**
 * Apply percent coupons to catalog regular price (not sale, not post-subscription).
 * Then {@link chooseBestUnitPrice} against sale and compare with subscription price.
 */
export function applyPercentCouponToUnitPrice(
  regularPrice: number,
  coupons: Array<{ discountType: string; amount: number }>,
): number {
  const multiplier = percentCouponMultiplier(coupons);
  if (multiplier >= 1) return roundMoney(regularPrice);
  return roundMoney(regularPrice * multiplier);
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

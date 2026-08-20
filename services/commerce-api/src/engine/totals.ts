import type { CartAddress, CartState } from "./types.js";
import { getItemFrequency } from "./types.js";
import {
  getSubscriptionDiscounts,
  lineUnitPrice,
  applyPercentCouponToUnitPrice,
  chooseBestUnitPrice,
} from "./pricing.js";
import {
  applyCoupons,
  loadCoupon,
  resolveShipping,
  type LoadedCoupon,
  type ShippingPackage,
  type FreeShippingInfo,
} from "./shipping.js";
import { isCouponUsageLimitReached } from "./coupon-meta.js";
import {
  countActiveTentativeCouponHolds,
  countUsedByForAliases,
  resolveUsageAliases,
} from "../repositories/coupon-holds.js";
import {
  getProductPrices,
  getStockInfo,
} from "../repositories/products.js";
import {
  fetchCartTax,
  type CartTaxResponse,
} from "../clients/mieland-wp-bridge.js";
import { moneyStr, roundMoney } from "../utils/index.js";

export type CartTotalsMode = "lightweight" | "full";

export type CartTaxBreakdown = {
  success: boolean;
  provider: string | null;
  taxTotal: string;
  contentsTax: string;
  shippingTax: string;
  feeTax: string;
  subtotal: string;
  shippingTotal: string;
  total: string;
  currency: string | null;
  message: string | null;
  taxTotals: Array<{ code: string; label: string; amount: string }>;
  items: Array<{
    productId: number;
    variationId: number;
    quantity: number;
    lineTotal: string;
    lineTax: string;
    name: string;
  }>;
};

export type CalculatedCart = {
  cart: CartState;
  itemCount: number;
  lines: Array<{
    key: string;
    productId: number;
    variationId: number | null;
    quantity: number;
    extraData: CartState["items"][0]["extraData"];
    unitPrice: number;
    displayUnitPrice: number;
    subtotal: string;
    frequency: string;
  }>;
  subtotal: string;
  total: string;
  shippingTotal: string;
  totalTax: string;
  taxBreakdown: CartTaxBreakdown | null;
  appliedCoupons: Array<{
    code: string;
    description: string;
    discountAmount: string;
    discountTax: string;
    discountType: string;
    amount: string;
  }>;
  availableShippingMethods: ShippingPackage[];
  chosenShippingMethods: string[];
  freeShippingInfo: FreeShippingInfo | null;
};

export type CalculateCartOptions = {
  /** Skip price/shipping/coupon work when the selection only needs keys/qty/itemCount. */
  pricing?: boolean;
  /** Logged-in user id — passed through for callers; email checks run at checkout. */
  userId?: number | null;
  /**
   * Call WP cart-tax bridge (TaxCloud). Defaults to true in full mode when
   * destination address is complete. Set false to skip (e.g. shipping-only).
   */
  calculateTax?: boolean;
  /** Override destination for tax preview (does not mutate cart). */
  taxAddress?: CartAddress | null;
  /** Override shipping cost sent to the tax bridge. */
  taxShippingCost?: number | null;
  /** Override shipping method id sent to the tax bridge. */
  taxShippingMethodId?: string | null;
};

const TAX_ADDRESS_FIELDS = [
  "country",
  "state",
  "postcode",
  "city",
  "address1",
] as const;

export function emptyTaxBreakdown(
  overrides: Partial<CartTaxBreakdown> = {},
): CartTaxBreakdown {
  return {
    success: false,
    provider: null,
    taxTotal: "0.00",
    contentsTax: "0.00",
    shippingTax: "0.00",
    feeTax: "0.00",
    subtotal: "0.00",
    shippingTotal: "0.00",
    total: "0.00",
    currency: null,
    message: null,
    taxTotals: [],
    items: [],
    ...overrides,
  };
}

export function mapCartTaxResponse(
  res: CartTaxResponse | null,
): CartTaxBreakdown {
  if (!res) {
    return emptyTaxBreakdown({
      message: "Tax calculation unavailable",
    });
  }
  const success = res.success !== false && res.taxTotal != null;
  const provider = res.provider ?? null;
  const taxTotal = res.taxTotal ?? "0.00";
  return {
    success,
    provider,
    taxTotal,
    contentsTax: res.contentsTax ?? "0.00",
    shippingTax: res.shippingTax ?? "0.00",
    feeTax: res.feeTax ?? "0.00",
    subtotal: res.subtotal ?? "0.00",
    shippingTotal: res.shippingTotal ?? "0.00",
    total: res.total ?? "0.00",
    currency: res.currency ?? null,
    // WP success payloads omit message — always fill one for checkout debug.
    message:
      res.message ??
      (success
        ? `OK — taxTotal ${taxTotal} via ${provider ?? "unknown"}`
        : "Tax calculation failed"),
    taxTotals: (res.taxTotals ?? []).map((t) => ({
      code: t.code,
      label: t.label,
      amount: t.amount,
    })),
    items: (res.items ?? []).map((item) => ({
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
      lineTax: item.lineTax,
      name: item.name,
    })),
  };
}

function resolveTaxAddress(
  cart: CartState,
  override?: CartAddress | null,
): CartAddress {
  if (override && TAX_ADDRESS_FIELDS.every((f) => override[f])) {
    return override;
  }
  const shipping = cart.shipping;
  const billing = cart.billing;
  if (TAX_ADDRESS_FIELDS.every((f) => shipping[f])) return shipping;
  if (TAX_ADDRESS_FIELDS.every((f) => billing[f])) return billing;
  return {
    country: shipping.country || billing.country,
    state: shipping.state || billing.state,
    postcode: shipping.postcode || billing.postcode,
    city: shipping.city || billing.city,
    address1: shipping.address1 || billing.address1,
    address2: shipping.address2 || billing.address2,
  };
}

function taxAddressComplete(addr: CartAddress): boolean {
  return TAX_ADDRESS_FIELDS.every((f) => Boolean(addr[f]?.trim()));
}

/** Refuse checkout when TaxCloud preview did not succeed for the cart address. */
export function assertCheckoutTaxCalculated(
  cart: CartState,
  calculated: CalculatedCart,
): void {
  const address = resolveTaxAddress(cart, null);
  if (!taxAddressComplete(address)) {
    throw new Error(
      "Complete delivery address is required before checkout",
    );
  }
  if (!calculated.chosenShippingMethods.length) {
    throw new Error("Shipping method is required before checkout");
  }
  if (!calculated.taxBreakdown?.success) {
    const msg = calculated.taxBreakdown?.message?.trim();
    throw new Error(
      msg || "Sales tax must be calculated successfully before checkout",
    );
  }
}

export async function calculateCart(
  cart: CartState,
  mode: CartTotalsMode = "full",
  options: CalculateCartOptions = {},
): Promise<CalculatedCart> {
  const pricing = options.pricing !== false;
  const itemCount = cart.items.reduce((n, i) => n + i.quantity, 0);

  if (!pricing) {
    return {
      cart,
      itemCount,
      lines: cart.items.map((item) => ({
        key: item.key,
        productId: item.productId,
        variationId: item.variationId,
        quantity: item.quantity,
        extraData: item.extraData,
        unitPrice: 0,
        displayUnitPrice: 0,
        subtotal: "0.00",
        frequency: getItemFrequency(item),
      })),
      subtotal: "0.00",
      total: "0.00",
      shippingTotal: "0.00",
      totalTax: "0.00",
      taxBreakdown: null,
      appliedCoupons: [],
      availableShippingMethods: [],
      chosenShippingMethods: cart.chosenShippingMethods,
      freeShippingInfo: null,
    };
  }

  const discounts = await getSubscriptionDiscounts();
  const priceIds = cart.items.map((i) => i.variationId || i.productId);
  const prices = await getProductPrices(priceIds);

  // Subscription % always from regular; sale wins only when cheaper than that.
  const pricedLines = cart.items.map((item) => {
    const parts = prices.get(item.variationId || item.productId) ?? {
      regular: 0,
      sale: null,
    };
    const afterSubFromRegular = lineUnitPrice(parts.regular, item, discounts);
    const unit = chooseBestUnitPrice(afterSubFromRegular, parts.sale);
    const lineSub = roundMoney(unit * item.quantity);
    return {
      key: item.key,
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      extraData: item.extraData,
      regular: parts.regular,
      sale: parts.sale,
      unitPrice: unit,
      subtotal: moneyStr(lineSub),
      frequency: getItemFrequency(item),
    };
  });
  let subtotalNum = 0;
  for (const line of pricedLines) {
    subtotalNum = roundMoney(subtotalNum + Number(line.subtotal));
  }

  const couponRows: LoadedCoupon[] = [];
  // Same identity set Woo uses for per-user usage / `_maybe_used_by_*`.
  const aliases = await resolveUsageAliases({
    customerId: cart.customerId,
    billingEmail: cart.billing.email,
  });
  for (const code of cart.coupons) {
    const c = await loadCoupon(code);
    if (!c || (c.isPersonalized && !c.isPersonalIssue)) continue;
    const holds = await countActiveTentativeCouponHolds(c.id, aliases);
    const globalLimit = c.usageLimit ?? (c.isPersonalIssue ? 1 : null);
    if (
      isCouponUsageLimitReached(c.usageCount, holds.global, globalLimit)
    ) {
      continue;
    }
    const perUserLimit =
      c.usageLimitPerUser ?? (c.isPersonalIssue ? 1 : null);
    if (perUserLimit != null) {
      const usedBy = aliases.length
        ? await countUsedByForAliases(c.id, aliases)
        : 0;
      if (isCouponUsageLimitReached(usedBy, holds.perUser, perUserLimit)) {
        continue;
      }
    }
    couponRows.push(c);
  }

  const percentCoupons = couponRows.filter((c) => c.discountType === "percent");
  const nonPercentCoupons = couponRows.filter(
    (c) => c.discountType !== "percent",
  );

  // Percent coupons from regular (not post-subscription); sale floors promo; subscription
  // still wins when it beats coupon-from-regular.
  const displayLines = pricedLines.map((line) => {
    const promoFromRegular = applyPercentCouponToUnitPrice(
      line.regular,
      couponRows,
    );
    const promoUnit = chooseBestUnitPrice(promoFromRegular, line.sale);
    const displayUnitPrice = roundMoney(Math.min(line.unitPrice, promoUnit));
    return {
      key: line.key,
      productId: line.productId,
      variationId: line.variationId,
      quantity: line.quantity,
      extraData: line.extraData,
      unitPrice: line.unitPrice,
      subtotal: line.subtotal,
      frequency: line.frequency,
      displayUnitPrice,
    };
  });

  let percentDiscountTotal = 0;
  for (const line of displayLines) {
    percentDiscountTotal = roundMoney(
      percentDiscountTotal +
        roundMoney((line.unitPrice - line.displayUnitPrice) * line.quantity),
    );
  }

  // Attribute percent coupon amounts from regular-price subtotal, then scale
  // to the sale-floored savings actually taken on the cart.
  let regularPathSubtotal = 0;
  for (const line of pricedLines) {
    regularPathSubtotal = roundMoney(
      regularPathSubtotal + roundMoney(line.regular * line.quantity),
    );
  }
  const { discountTotal: idealPercentTotal, applied: percentAppliedIdeal } =
    applyCoupons(
      regularPathSubtotal,
      percentCoupons,
      pricedLines.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.regular,
      })),
    );
  const percentScale =
    idealPercentTotal > 0 ? percentDiscountTotal / idealPercentTotal : 0;
  const percentApplied = percentAppliedIdeal.map((row) => ({
    ...row,
    discountAmount: roundMoney(Number(row.discountAmount) * percentScale).toFixed(
      2,
    ),
  }));
  // Keep attributed percent amounts summing to the sale-floored total.
  if (percentApplied.length > 0) {
    let attributed = 0;
    for (let i = 0; i < percentApplied.length - 1; i++) {
      attributed = roundMoney(attributed + Number(percentApplied[i].discountAmount));
    }
    percentApplied[percentApplied.length - 1].discountAmount = roundMoney(
      Math.max(0, percentDiscountTotal - attributed),
    ).toFixed(2);
  }

  const afterPercent = roundMoney(Math.max(0, subtotalNum - percentDiscountTotal));
  const { discountTotal: fixedDiscountTotal, applied: fixedApplied } =
    applyCoupons(
      afterPercent,
      nonPercentCoupons,
      displayLines.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    );
  const discountTotal = roundMoney(percentDiscountTotal + fixedDiscountTotal);
  const applied = [...percentApplied, ...fixedApplied];
  const afterDiscount = roundMoney(Math.max(0, subtotalNum - discountTotal));

  let shippingTotal = 0;
  let packages: ShippingPackage[] = [];
  let chosen = cart.chosenShippingMethods;
  let freeShippingInfo: FreeShippingInfo | null = null;

  if (mode === "full") {
    // Free-shipping min_amount is based on cart subtotal (before coupons), not total.
    // Subscription lines bypass min_amount and always unlock free shipping.
    const shipping = await resolveShipping(cart, subtotalNum);
    packages = shipping.packages;
    shippingTotal = shipping.chosenCost;
    chosen = shipping.chosenIds;
    freeShippingInfo = shipping.freeShippingInfo;
  }

  let totalTax = 0;
  let taxBreakdown: CartTaxBreakdown | null = null;
  const wantTax = options.calculateTax !== false && mode === "full";

  if (wantTax && cart.items.length > 0) {
    const address = resolveTaxAddress(cart, options.taxAddress);
    if (taxAddressComplete(address)) {
      const chosenRate = packages
        .flatMap((p) => p.rates)
        .find((r) => chosen.includes(r.id));
      const methodId =
        options.taxShippingMethodId ??
        chosenRate?.methodId ??
        chosen[0]?.split(":")[0] ??
        "flat_rate";
      const shipCost =
        options.taxShippingCost != null
          ? options.taxShippingCost
          : shippingTotal;

      const bridge = await fetchCartTax({
        items: displayLines.map((line) => ({
          productId: line.productId,
          variationId: line.variationId ?? 0,
          quantity: line.quantity,
          unitPrice: line.displayUnitPrice,
        })),
        address: {
          country: address.country,
          state: address.state,
          postcode: address.postcode,
          city: address.city,
          address1: address.address1,
          address2: address.address2 ?? "",
        },
        shipping: {
          cost: shipCost,
          methodId,
        },
        customerId: cart.customerId ?? options.userId ?? 0,
      });

      taxBreakdown = mapCartTaxResponse(bridge);
      if (taxBreakdown.success) {
        totalTax = roundMoney(Number(taxBreakdown.taxTotal) || 0);
      }
    } else {
      taxBreakdown = emptyTaxBreakdown({
        message: "Incomplete delivery address",
        shippingTotal: moneyStr(shippingTotal),
        subtotal: moneyStr(subtotalNum),
      });
    }
  }

  const total = roundMoney(afterDiscount + shippingTotal + totalTax);

  return {
    cart: { ...cart, chosenShippingMethods: chosen },
    itemCount,
    lines: displayLines,
    subtotal: moneyStr(subtotalNum),
    total: moneyStr(total),
    shippingTotal: moneyStr(shippingTotal),
    totalTax: moneyStr(totalTax),
    taxBreakdown,
    appliedCoupons: applied,
    availableShippingMethods: packages,
    chosenShippingMethods: chosen,
    freeShippingInfo,
  };
}

export async function assertInStock(
  productId: number,
  variationId: number | null,
  quantity: number,
): Promise<void> {
  const id = variationId || productId;
  const stock = await getStockInfo(id);
  if (stock.status === "outofstock") {
    throw new Error("Product is out of stock");
  }
  if (!stock.manageStock || stock.allowsBackorders) return;
  const available = stock.stockQuantity ?? 0;
  if (quantity > available) {
    throw new Error(
      available <= 0
        ? "Product is out of stock"
        : `Not enough stock (${available} available)`,
    );
  }
}

import type { CartState } from "./types.js";
import { getItemFrequency } from "./types.js";
import { getSubscriptionDiscounts, lineUnitPrice } from "./pricing.js";
import {
  applyCoupons,
  loadCoupon,
  resolveShipping,
  type ShippingPackage,
} from "./shipping.js";
import {
  getProductPrices,
  getStockStatus,
} from "../repositories/products.js";
import { moneyStr, roundMoney } from "../utils/index.js";

export type CartTotalsMode = "lightweight" | "full";

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
    subtotal: string;
    frequency: string;
  }>;
  subtotal: string;
  total: string;
  shippingTotal: string;
  totalTax: string;
  appliedCoupons: Array<{
    code: string;
    description: string;
    discountAmount: string;
    discountTax: string;
  }>;
  availableShippingMethods: ShippingPackage[];
  chosenShippingMethods: string[];
};

export type CalculateCartOptions = {
  /** Skip price/shipping/coupon work when the selection only needs keys/qty/itemCount. */
  pricing?: boolean;
};

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
        subtotal: "0.00",
        frequency: getItemFrequency(item),
      })),
      subtotal: "0.00",
      total: "0.00",
      shippingTotal: "0.00",
      totalTax: "0.00",
      appliedCoupons: [],
      availableShippingMethods: [],
      chosenShippingMethods: cart.chosenShippingMethods,
    };
  }

  const discounts = await getSubscriptionDiscounts();
  const priceIds = cart.items.map((i) => i.variationId || i.productId);
  const prices = await getProductPrices(priceIds);

  const lines = [];
  let subtotalNum = 0;
  for (const item of cart.items) {
    const base = prices.get(item.variationId || item.productId) ?? 0;
    const unit = lineUnitPrice(base, item, discounts);
    const lineSub = roundMoney(unit * item.quantity);
    subtotalNum = roundMoney(subtotalNum + lineSub);
    lines.push({
      key: item.key,
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      extraData: item.extraData,
      unitPrice: unit,
      subtotal: moneyStr(lineSub),
      frequency: getItemFrequency(item),
    });
  }

  const couponRows = [];
  for (const code of cart.coupons) {
    const c = await loadCoupon(code);
    if (c) couponRows.push(c);
  }
  const { discountTotal, applied } = applyCoupons(subtotalNum, couponRows);
  const afterDiscount = roundMoney(Math.max(0, subtotalNum - discountTotal));

  let shippingTotal = 0;
  let packages: ShippingPackage[] = [];
  let chosen = cart.chosenShippingMethods;

  if (mode === "full") {
    const shipping = await resolveShipping(cart, afterDiscount);
    packages = shipping.packages;
    shippingTotal = shipping.chosenCost;
    chosen = shipping.chosenIds;
  }

  const totalTax = 0;
  const total = roundMoney(afterDiscount + shippingTotal + totalTax);

  return {
    cart: { ...cart, chosenShippingMethods: chosen },
    itemCount,
    lines,
    subtotal: moneyStr(subtotalNum),
    total: moneyStr(total),
    shippingTotal: moneyStr(shippingTotal),
    totalTax: moneyStr(totalTax),
    appliedCoupons: applied,
    availableShippingMethods: packages,
    chosenShippingMethods: chosen,
  };
}

export async function assertInStock(
  productId: number,
  variationId: number | null,
  quantity: number,
): Promise<void> {
  const id = variationId || productId;
  const status = await getStockStatus(id);
  if (status === "outofstock") {
    throw new Error("Product is out of stock");
  }
  void quantity;
}

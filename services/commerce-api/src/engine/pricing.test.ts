import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFrequencyDiscount,
  applyPercentCouponToUnitPrice,
  chooseBestUnitPrice,
  percentCouponMultiplier,
} from "./pricing.js";

describe("applyFrequencyDiscount", () => {
  it("applies subscription discount to regular price", () => {
    const discounts = { monthly: 15, quarterly: 10 };
    const result = applyFrequencyDiscount(100, "monthly", discounts);
    assert.equal(result, 85); // 15% off $100
  });

  it("returns regular price when frequency is not in discounts", () => {
    const discounts = { monthly: 15 };
    const result = applyFrequencyDiscount(100, "quarterly", discounts);
    assert.equal(result, 100);
  });

  it("handles zero discount", () => {
    const discounts = { monthly: 0 };
    const result = applyFrequencyDiscount(100, "monthly", discounts);
    assert.equal(result, 100);
  });

  it("handles negative prices", () => {
    const discounts = { monthly: 15 };
    const result = applyFrequencyDiscount(-100, "monthly", discounts);
    assert.equal(result, -100);
  });
});

describe("chooseBestUnitPrice", () => {
  it("prefers sale price when it beats discounted regular", () => {
    const result = chooseBestUnitPrice(85, 79.97);
    assert.equal(result, 79.97);
  });

  it("uses discounted regular when sale is higher", () => {
    const result = chooseBestUnitPrice(75, 85);
    assert.equal(result, 75);
  });

  it("handles null sale price", () => {
    const result = chooseBestUnitPrice(75, null);
    assert.equal(result, 75);
  });

  it("handles undefined sale price", () => {
    const result = chooseBestUnitPrice(75, undefined);
    assert.equal(result, 75);
  });

  it("handles zero sale price", () => {
    const result = chooseBestUnitPrice(75, 0);
    assert.equal(result, 75);
  });
});

describe("percentCouponMultiplier", () => {
  it("calculates multiplier for single percent coupon", () => {
    const coupons = [{ discountType: "percent", amount: 10 }];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 0.9); // 10% off → 0.9 multiplier
  });

  it("calculates multiplier for multiple percent coupons", () => {
    const coupons = [
      { discountType: "percent", amount: 10 },
      { discountType: "percent", amount: 10 },
    ];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 0.81); // 10% off twice → 0.81 multiplier
  });

  it("ignores non-percent coupons", () => {
    const coupons = [
      { discountType: "fixed_cart", amount: 5 },
      { discountType: "percent", amount: 10 },
    ];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 0.9); // Only 10% applies
  });

  it("ignores zero-amount coupons", () => {
    const coupons = [
      { discountType: "percent", amount: 0 },
      { discountType: "percent", amount: 10 },
    ];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 0.9);
  });

  it("caps discount at 100%", () => {
    const coupons = [{ discountType: "percent", amount: 150 }];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 0); // Capped at 100% → 0 multiplier
  });

  it("returns 1 when no percent coupons", () => {
    const coupons = [{ discountType: "fixed_cart", amount: 5 }];
    const result = percentCouponMultiplier(coupons);
    assert.equal(result, 1);
  });
});

describe("applyPercentCouponToUnitPrice", () => {
  it("applies percent coupon to unit price", () => {
    const coupons = [{ discountType: "percent", amount: 10 }];
    const result = applyPercentCouponToUnitPrice(100, coupons);
    assert.equal(result, 90); // 10% off $100
  });

  it("applies multiple percent coupons sequentially", () => {
    const coupons = [
      { discountType: "percent", amount: 10 },
      { discountType: "percent", amount: 10 },
    ];
    const result = applyPercentCouponToUnitPrice(100, coupons);
    assert.equal(result, 81); // 10% off twice
  });

  it("returns original price when no percent coupons", () => {
    const coupons = [{ discountType: "fixed_cart", amount: 5 }];
    const result = applyPercentCouponToUnitPrice(100, coupons);
    assert.equal(result, 100);
  });

  it("handles empty coupon array", () => {
    const result = applyPercentCouponToUnitPrice(100, []);
    assert.equal(result, 100);
  });

  it("applies percent coupon to sale price (not regular)", () => {
    // This is the key behavior: percent coupons apply to the actual cart line price
    const salePrice = 79.97;
    const coupons = [{ discountType: "percent", amount: 10 }];
    const result = applyPercentCouponToUnitPrice(salePrice, coupons);
    assert.equal(result, 71.97); // 10% off $79.97 (rounded)
  });
});

describe("WooCommerce percent-coupon regression", () => {
  it("Daily Wellness Starter Kit with 99% coupon (product #3435, coupon TEST17)", () => {
    // Catalog from live WP:
    // - Product #3435 Daily Wellness Starter Kit
    // - Regular: $89.97
    // - Sale: $79.97
    // - Coupon TEST17: 99% percent discount, no exclude_sale_items
    //
    // Observed WooCommerce order 3742 (coupon test16, same 99%):
    // - Subtotal: $79.97
    // - Coupon discount: -$79.17
    // - Total: $0.80
    //
    // Commerce must match: 99% of sale price $79.97 = $0.80 leftover (not $0.90 from regular).

    const regular = 89.97;
    const sale = 79.97;
    const coupons = [{ discountType: "percent", amount: 99 }];

    // Step 1: No subscription discount, so choose between regular and sale
    const linePrice = chooseBestUnitPrice(regular, sale);
    assert.equal(linePrice, 79.97); // Sale wins

    // Step 2: Apply 99% coupon to the line price (sale price)
    const afterCoupon = applyPercentCouponToUnitPrice(linePrice, coupons);
    assert.equal(afterCoupon, 0.8); // 1% of $79.97 = $0.7997 → $0.80

    // This matches WooCommerce order 3742 total of $0.80
  });

  it("Daily Wellness Kit with 99% coupon when NOT on sale", () => {
    // If the kit were not on sale, 99% of regular $89.97 should yield $0.90
    const regular = 89.97;
    const sale = null;
    const coupons = [{ discountType: "percent", amount: 99 }];

    const linePrice = chooseBestUnitPrice(regular, sale);
    assert.equal(linePrice, 89.97); // No sale

    const afterCoupon = applyPercentCouponToUnitPrice(linePrice, coupons);
    assert.equal(afterCoupon, 0.9); // 1% of $89.97 = $0.8997 → $0.90
  });

  it("percent coupon respects subscription discount first, then applies to result", () => {
    // Scenario: $100 regular, $90 sale, 15% subscription, 50% coupon
    // Step 1: Subscription from regular: $100 * 0.85 = $85
    // Step 2: Compare with sale: min($85, $90) = $85
    // Step 3: Apply coupon to line price: $85 * 0.5 = $42.50

    const regular = 100;
    const sale = 90;
    const subscriptionDiscounts = { monthly: 15 };
    const coupons = [{ discountType: "percent", amount: 50 }];

    const afterSubscription = applyFrequencyDiscount(regular, "monthly", subscriptionDiscounts);
    assert.equal(afterSubscription, 85); // 15% off $100

    const linePrice = chooseBestUnitPrice(afterSubscription, sale);
    assert.equal(linePrice, 85); // Subscription beats sale

    const afterCoupon = applyPercentCouponToUnitPrice(linePrice, coupons);
    assert.equal(afterCoupon, 42.5); // 50% off $85
  });

  it("percent coupon applies to sale when sale beats subscription", () => {
    // Scenario: $100 regular, $70 sale, 15% subscription, 50% coupon
    // Step 1: Subscription from regular: $100 * 0.85 = $85
    // Step 2: Compare with sale: min($85, $70) = $70
    // Step 3: Apply coupon to line price: $70 * 0.5 = $35

    const regular = 100;
    const sale = 70;
    const subscriptionDiscounts = { monthly: 15 };
    const coupons = [{ discountType: "percent", amount: 50 }];

    const afterSubscription = applyFrequencyDiscount(regular, "monthly", subscriptionDiscounts);
    assert.equal(afterSubscription, 85);

    const linePrice = chooseBestUnitPrice(afterSubscription, sale);
    assert.equal(linePrice, 70); // Sale beats subscription

    const afterCoupon = applyPercentCouponToUnitPrice(linePrice, coupons);
    assert.equal(afterCoupon, 35); // 50% off $70 (sale price)
  });
});

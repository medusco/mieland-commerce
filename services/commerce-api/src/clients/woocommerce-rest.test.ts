import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CalculatedCart } from "../engine/totals.js";
import type { CartState } from "../engine/types.js";
import { buildWcOrderLineItemsFromCalculated } from "./woocommerce-rest.js";
import { expandWcOrderLineItemsForProductBundles } from "./wc-order-bundles.js";

function emptyCalculated(cart: CartState): CalculatedCart {
  return {
    cart,
    itemCount: cart.items.reduce((n, i) => n + i.quantity, 0),
    lines: cart.items.map((item) => ({
      key: item.key,
      productId: item.productId,
      variationId: item.variationId,
      quantity: item.quantity,
      extraData: item.extraData,
      unitPrice: 10,
      displayUnitPrice: 10,
      subtotal: "10.00",
      frequency: "",
    })),
    subtotal: "10.00",
    total: "10.00",
    shippingTotal: "0.00",
    totalTax: "0.00",
    taxBreakdown: null,
    appliedCoupons: [],
    availableShippingMethods: [],
    chosenShippingMethods: [],
    freeShippingInfo: null,
  };
}

describe("buildWcOrderFromCart line items", () => {
  it("leaves non-bundle line items unchanged when no bundle ids match", async () => {
    const cart: CartState = {
      items: [
        {
          key: "a",
          productId: 100,
          variationId: null,
          quantity: 2,
          extraData: [{ key: "color", value: "blue" }],
        },
      ],
      coupons: [],
      chosenShippingMethods: [],
      customerId: null,
      billing: { email: "a@b.com" },
      shipping: {},
      shippingSameAsBilling: true,
    };
    const calculated = emptyCalculated(cart);
    const lineItems = await expandWcOrderLineItemsForProductBundles(
      buildWcOrderLineItemsFromCalculated(calculated),
      calculated.lines.map((line) => ({
        productId: line.productId,
        variationId: line.variationId,
        quantity: line.quantity,
        extraData: line.extraData,
      })),
      {
        getBundleProductIds: async () => new Set(),
        loadBundleCatalogByProductIds: async () => new Map(),
        buildBundleConfigurationForLine: async () => [],
      },
    );

    assert.equal(lineItems.length, 1);
    assert.equal(lineItems[0].product_id, 100);
    assert.equal(lineItems[0].quantity, 2);
    assert.equal(lineItems[0].bundle_configuration, undefined);
    assert.deepEqual(lineItems[0].meta_data, [{ key: "color", value: "blue" }]);
  });
});

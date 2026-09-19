import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expandWcOrderLineItemsForProductBundles } from "./wc-order-bundles.js";

describe("expandWcOrderLineItemsForProductBundles", () => {
  it("adds bundle_configuration for bundle parents only", async () => {
    const lineItems = [
      { product_id: 99, quantity: 1 },
      {
        product_id: 3435,
        quantity: 1,
        meta_data: [{ key: "_subscription_frequency", value: "monthly" }],
      },
    ];
    const lines = [
      { productId: 99, variationId: null, quantity: 1, extraData: [] },
      {
        productId: 3435,
        variationId: null,
        quantity: 1,
        extraData: [],
      },
    ];

    const out = await expandWcOrderLineItemsForProductBundles(lineItems, lines, {
      getBundleProductIds: async () => new Set([3435]),
      loadBundleCatalogByProductIds: async () => new Map([[3435, []]]),
      buildBundleConfigurationForLine: async () => [
        { bundled_item_id: 412, product_id: 1371, quantity: 1 },
        { bundled_item_id: 413, product_id: 2970, quantity: 1 },
      ],
    });

    assert.equal(out[0].bundle_configuration, undefined);
    assert.equal(out[1].bundle_configuration?.length, 2);
    assert.deepEqual(out[1].meta_data, [
      { key: "_subscription_frequency", value: "monthly" },
    ]);
  });
});

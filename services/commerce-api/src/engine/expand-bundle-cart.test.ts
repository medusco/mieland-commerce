import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyCart } from "./types.js";
import { addBundleProductToCart } from "./expand-bundle-cart.js";
import { bundledChildKeysByParentKey, cartLineBundleMeta } from "./bundle-cart.js";

describe("addBundleProductToCart", () => {
  it("creates parent and child lines linked by _bundled_by", () => {
    const cart = emptyCart();
    addBundleProductToCart(cart, {
      bundleProductId: 3437,
      bundleVariationId: null,
      quantity: 1,
      extraData: [],
      catalog: [
        {
          bundledItemId: 8,
          productId: 1372,
          variationId: null,
          quantityPerBundle: 1,
        },
        {
          bundledItemId: 9,
          productId: 1367,
          variationId: null,
          quantityPerBundle: 1,
        },
      ],
    });

    assert.equal(cart.items.length, 3);
    const parent = cart.items[0];
    const parentMeta = cartLineBundleMeta(parent.extraData);
    assert.equal(parentMeta.isBundledItem, false);
    assert.ok(parentMeta.bundleContainerStamp);

    const children = cart.items.slice(1);
    for (const child of children) {
      const meta = cartLineBundleMeta(child.extraData);
      assert.equal(meta.isBundledItem, true);
      assert.equal(meta.bundledByCartKey, parent.key);
    }

    const map = bundledChildKeysByParentKey(
      cart.items.map((line) => ({ key: line.key, extraData: line.extraData })),
    );
    assert.deepEqual(map.get(parent.key), children.map((c) => c.key));
  });
});

import { randomToken } from "../utils/index.js";
import type { BundledCatalogItem } from "../repositories/product-bundles.js";
import type { CartExtraData, CartItem, CartState } from "./types.js";
import { makeCartItemKey } from "./cart-store.js";

function withStamp(extraData: CartExtraData[], stamp: string): CartExtraData[] {
  const withoutStamp = extraData.filter(
    (entry) =>
      entry.key?.trim().replace(/^_+/, "").toLowerCase() !== "stamp",
  );
  return [...withoutStamp, { key: "stamp", value: stamp }];
}

function childExtraData(
  parentCartKey: string,
  bundledItemId: number,
): CartExtraData[] {
  return [
    { key: "_bundled_by", value: parentCartKey },
    { key: "_bundled_item_id", value: String(bundledItemId) },
  ];
}

/** Add Woo Product Bundles parent + component lines (matches `_bundled_by` / `stamp` extraData). */
export function addBundleProductToCart(
  cart: CartState,
  args: {
    bundleProductId: number;
    bundleVariationId: number | null;
    quantity: number;
    extraData: CartExtraData[];
    catalog: BundledCatalogItem[];
  },
): void {
  const { bundleProductId, bundleVariationId, quantity, catalog } = args;
  const stamp = randomToken(8);
  const parentExtra = withStamp(args.extraData, stamp);
  const parentKey = makeCartItemKey(
    bundleProductId,
    bundleVariationId,
    parentExtra,
  );

  cart.items.push({
    key: parentKey,
    productId: bundleProductId,
    variationId: bundleVariationId,
    quantity,
    extraData: parentExtra,
  });

  for (const entry of catalog) {
    const childExtra = childExtraData(parentKey, entry.bundledItemId);
    cart.items.push({
      key: makeCartItemKey(entry.productId, entry.variationId, childExtra),
      productId: entry.productId,
      variationId: entry.variationId,
      quantity: entry.quantityPerBundle * quantity,
      extraData: childExtra,
    });
  }
}

export function catalogBundledProductsForParent(
  parentLine: CartItem,
  catalog: BundledCatalogItem[],
): Array<{
  key: string;
  quantity: number;
  productId: number;
  variationId: number | null;
}> {
  return catalog.map((entry) => ({
    key: `catalog:${parentLine.key}:${entry.bundledItemId}`,
    quantity: entry.quantityPerBundle * parentLine.quantity,
    productId: entry.productId,
    variationId: entry.variationId,
  }));
}

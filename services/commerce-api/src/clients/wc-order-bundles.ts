import type { CalculatedCart } from "../engine/totals.js";
import type { CartExtraData } from "../engine/types.js";
import {
  buildBundleConfigurationForLine,
  getBundleProductIds,
  loadBundleCatalogByProductIds,
  type WcBundleConfigurationEntry,
} from "../repositories/product-bundles.js";

export type WcOrderBundleExpansionDeps = {
  getBundleProductIds: typeof getBundleProductIds;
  loadBundleCatalogByProductIds: typeof loadBundleCatalogByProductIds;
  buildBundleConfigurationForLine: typeof buildBundleConfigurationForLine;
};

const defaultExpansionDeps: WcOrderBundleExpansionDeps = {
  getBundleProductIds,
  loadBundleCatalogByProductIds,
  buildBundleConfigurationForLine,
};

export type WcOrderLineItem = {
  product_id: number;
  variation_id?: number;
  quantity: number;
  meta_data?: Array<{ key: string; value: string }>;
  bundle_configuration?: WcBundleConfigurationEntry[];
};

export async function expandWcOrderLineItemsForProductBundles(
  lineItems: WcOrderLineItem[],
  lines: Array<{
    productId: number;
    variationId: number | null;
    quantity: number;
    extraData: CartExtraData[];
  }>,
  deps: WcOrderBundleExpansionDeps = defaultExpansionDeps,
): Promise<WcOrderLineItem[]> {
  if (!lineItems.length) return lineItems;

  const productIds = lines.map((l) => l.productId);
  const bundleIds = await deps.getBundleProductIds(productIds);
  if (!bundleIds.size) return lineItems;

  const catalogByBundle = await deps.loadBundleCatalogByProductIds([...bundleIds]);

  const out: WcOrderLineItem[] = [];
  for (let i = 0; i < lineItems.length; i++) {
    const line = lineItems[i]!;
    const source = lines[i];
    if (!source || !bundleIds.has(source.productId)) {
      out.push(line);
      continue;
    }

    const catalog = catalogByBundle.get(source.productId) ?? [];
    const bundle_configuration = await deps.buildBundleConfigurationForLine(
      catalog,
      source.quantity,
      source.extraData,
    );
    out.push(
      bundle_configuration.length
        ? { ...line, bundle_configuration }
        : line,
    );
  }
  return out;
}

export async function expandCalculatedCartLineItemsForProductBundles(
  calculated: CalculatedCart,
  lineItems: WcOrderLineItem[],
): Promise<WcOrderLineItem[]> {
  return expandWcOrderLineItemsForProductBundles(
    lineItems,
    calculated.lines.map((line) => ({
      productId: line.productId,
      variationId: line.variationId,
      quantity: line.quantity,
      extraData: line.extraData,
    })),
  );
}

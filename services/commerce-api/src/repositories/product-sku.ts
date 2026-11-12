/**
 * Parse WooCommerce `_sku` postmeta.
 * Trimmed; empty or missing -> null. No parent fallback (matches Woo REST).
 */
export function parseProductSku(
  meta: Record<string, string> | null | undefined,
): string | null {
  if (!meta) return null;
  if (!Object.prototype.hasOwnProperty.call(meta, "_sku")) return null;
  const trimmed = String(meta._sku ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve SKU for a GraphQL product / variation node.
 * Prefers a pre-hydrated `sku` (list batch path). Uses `_acfMeta` when the
 * bag includes `_sku` or is a complete postmeta load. Otherwise one keyed
 * postmeta lookup — safe when selection-based lean hydrate omitted `_sku`.
 */
export async function resolveProductSku(product: {
  databaseId?: number | null;
  sku?: string | null;
  _acfMeta?: Record<string, string>;
  /** True when `_acfMeta` came from full getPostMetaMany (not lean key subset). */
  _postMetaComplete?: boolean;
}): Promise<string | null> {
  if (Object.prototype.hasOwnProperty.call(product, "sku")) {
    return product.sku ?? null;
  }

  if (product._acfMeta) {
    const meta = product._acfMeta;
    if (
      Object.prototype.hasOwnProperty.call(meta, "_sku") ||
      product._postMetaComplete
    ) {
      return parseProductSku(meta);
    }
  }

  const id = product.databaseId;
  if (!id) return null;

  const { getPostMetaKeysMany } = await import("./products.js");
  const map = await getPostMetaKeysMany([id], ["_sku"]);
  return parseProductSku(map.get(id) ?? {});
}

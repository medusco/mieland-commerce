import { query, t } from "../db/mysql.js";

export type BundledCatalogItem = {
  bundledItemId: number;
  productId: number;
  variationId: number | null;
  /** Per one parent bundle quantity. */
  quantityPerBundle: number;
};

function quantityFromMeta(meta: Record<string, string>): number {
  const raw =
    meta.quantity_default?.trim() ||
    meta.quantity_min?.trim() ||
    meta.quantity_max?.trim() ||
    "1";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** Woo Product Bundles catalog rows for a bundle product (`product_type` = bundle). */
function mapBundledRows(
  items: { bundled_item_id: number; product_id: number; menu_order: number }[],
  metaRows: { bundled_item_id: number; meta_key: string; meta_value: string }[],
): BundledCatalogItem[] {
  const metaByItem = new Map<number, Record<string, string>>();
  for (const row of metaRows) {
    const bag = metaByItem.get(row.bundled_item_id) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    metaByItem.set(row.bundled_item_id, bag);
  }

  return items.map((row) => {
    const meta = metaByItem.get(row.bundled_item_id) ?? {};
    const variationRaw = meta.default_variation_id?.trim();
    const variationId =
      variationRaw && Number(variationRaw) > 0 ? Number(variationRaw) : null;
    return {
      bundledItemId: row.bundled_item_id,
      productId: row.product_id,
      variationId,
      quantityPerBundle: quantityFromMeta(meta),
    };
  });
}

export async function getBundledCatalogItemsMany(
  bundleProductIds: number[],
): Promise<Map<number, BundledCatalogItem[]>> {
  const unique = [
    ...new Set(bundleProductIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, BundledCatalogItem[]>();
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const items = await query<
    { bundle_id: number; bundled_item_id: number; product_id: number; menu_order: number }[]
  >(
    `SELECT bundle_id, bundled_item_id, product_id, menu_order
     FROM ${t("woocommerce_bundled_items")}
     WHERE bundle_id IN (${placeholders})
     ORDER BY bundle_id ASC, menu_order ASC, bundled_item_id ASC`,
    unique,
  );
  if (!items.length) return out;

  const ids = items.map((row) => row.bundled_item_id);
  const idPh = ids.map(() => "?").join(",");
  const metaRows = await query<
    { bundled_item_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT bundled_item_id, meta_key, meta_value
     FROM ${t("woocommerce_bundled_itemmeta")}
     WHERE bundled_item_id IN (${idPh})`,
    ids,
  );

  const byBundle = new Map<
    number,
    { bundled_item_id: number; product_id: number; menu_order: number }[]
  >();
  for (const row of items) {
    const list = byBundle.get(row.bundle_id) ?? [];
    list.push(row);
    byBundle.set(row.bundle_id, list);
  }
  for (const bundleId of unique) {
    const rows = byBundle.get(bundleId) ?? [];
    out.set(bundleId, rows.length ? mapBundledRows(rows, metaRows) : []);
  }
  return out;
}

export async function getBundledCatalogItems(
  bundleProductId: number,
): Promise<BundledCatalogItem[]> {
  if (!Number.isFinite(bundleProductId) || bundleProductId <= 0) return [];

  const items = await query<
    { bundled_item_id: number; product_id: number; menu_order: number }[]
  >(
    `SELECT bundled_item_id, product_id, menu_order
     FROM ${t("woocommerce_bundled_items")}
     WHERE bundle_id = ?
     ORDER BY menu_order ASC, bundled_item_id ASC`,
    [bundleProductId],
  );
  if (!items.length) return [];

  const ids = items.map((row) => row.bundled_item_id);
  const placeholders = ids.map(() => "?").join(",");
  const metaRows = await query<
    { bundled_item_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT bundled_item_id, meta_key, meta_value
     FROM ${t("woocommerce_bundled_itemmeta")}
     WHERE bundled_item_id IN (${placeholders})`,
    ids,
  );

  return mapBundledRows(items, metaRows);
}

const bundleTypeCache = new Map<number, boolean>();

export async function isBundleProduct(productId: number): Promise<boolean> {
  if (!Number.isFinite(productId) || productId <= 0) return false;
  const cached = bundleTypeCache.get(productId);
  if (cached !== undefined) return cached;

  const rows = await query<{ slug: string }[]>(
    `SELECT terms.slug
     FROM ${t("term_relationships")} tr
     JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tr.object_id = ? AND tt.taxonomy = 'product_type' AND terms.slug = 'bundle'
     LIMIT 1`,
    [productId],
  );
  const isBundle = rows.length > 0;
  bundleTypeCache.set(productId, isBundle);
  return isBundle;
}

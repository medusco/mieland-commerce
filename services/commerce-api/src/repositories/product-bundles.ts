import { query, t } from "../db/mysql.js";
import { loadConfig } from "../config.js";
import { getRedis } from "../redis/client.js";
import { maybeUnserializePhp } from "./options.js";
import { getPostMetaMany } from "./products.js";
import type { CartExtraData } from "../engine/types.js";

export type WcBundleConfigurationEntry = {
  bundled_item_id: number;
  product_id: number;
  quantity: number;
  optional_selected?: boolean;
  variation_id?: number;
  attributes?: Array<{ name: string; option: string }>;
};

export type BundledCatalogItem = {
  bundledItemId: number;
  productId: number;
  menuOrder: number;
  quantityMin: number;
  quantityMax: number;
  optional: boolean;
  overrideDefaultVariationAttributes: boolean;
  defaultVariationAttributes: Array<{ name: string; option: string }>;
  allowedVariationIds: number[];
};

function catalogTtl(): number {
  return loadConfig().CATALOG_CACHE_TTL_SECONDS;
}

function bundleCatalogCacheKey(bundleId: number): string {
  return `product-bundle:v1:${bundleId}`;
}

function parseBundledItemMeta(
  meta: Record<string, string>,
): Omit<
  BundledCatalogItem,
  "bundledItemId" | "productId" | "menuOrder"
> {
  const qtyMin = Math.max(1, Number(meta.quantity_min || 1) || 1);
  const qtyMaxRaw = Number(meta.quantity_max || 0);
  const quantityMax =
    qtyMaxRaw > 0 ? Math.max(qtyMin, qtyMaxRaw) : Math.max(qtyMin, qtyMin);
  const optional = meta.optional === "yes";

  const overrideDefaultVariationAttributes =
    meta.override_default_variation_attributes === "yes";

  let defaultVariationAttributes: Array<{ name: string; option: string }> = [];
  const defaultRaw = meta.default_variation_attributes;
  if (defaultRaw) {
    const parsed = maybeUnserializePhp(defaultRaw);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        const name = String(
          (row as { name?: string }).name ?? (row as { key?: string }).key ?? "",
        ).trim();
        const option = String(
          (row as { option?: string }).option ??
            (row as { value?: string }).value ??
            "",
        ).trim();
        if (name && option) defaultVariationAttributes.push({ name, option });
      }
    }
  }

  let allowedVariationIds: number[] = [];
  const allowedRaw = meta.allowed_variations;
  if (allowedRaw) {
    const parsed = maybeUnserializePhp(allowedRaw);
    if (Array.isArray(parsed)) {
      allowedVariationIds = parsed
        .map((v) => Number(v))
        .filter((id) => Number.isFinite(id) && id > 0);
    }
  }

  return {
    quantityMin: qtyMin,
    quantityMax: quantityMax,
    optional,
    overrideDefaultVariationAttributes,
    defaultVariationAttributes,
    allowedVariationIds,
  };
}

export async function getBundleProductIds(
  productIds: number[],
): Promise<Set<number>> {
  const unique = [...new Set(productIds.filter((id) => id > 0))];
  const out = new Set<number>();
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<{ object_id: number }[]>(
    `SELECT tr.object_id
     FROM ${t("term_relationships")} tr
     JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tr.object_id IN (${placeholders})
       AND tt.taxonomy = 'product_type'
       AND terms.slug = 'bundle'`,
    unique,
  );
  for (const row of rows) out.add(Number(row.object_id));
  return out;
}

async function loadBundledCatalogItemsUncached(
  bundleId: number,
): Promise<BundledCatalogItem[]> {
  const rows = await query<
    { bundled_item_id: number; product_id: number; menu_order: number }[]
  >(
    `SELECT bundled_item_id, product_id, menu_order
     FROM ${t("woocommerce_bundled_items")}
     WHERE bundle_id = ?
     ORDER BY menu_order ASC, bundled_item_id ASC`,
    [bundleId],
  );
  if (!rows.length) return [];

  const itemIds = rows.map((r) => Number(r.bundled_item_id));
  const placeholders = itemIds.map(() => "?").join(",");
  const metaRows = await query<
    { bundled_item_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT bundled_item_id, meta_key, meta_value
     FROM ${t("woocommerce_bundled_itemmeta")}
     WHERE bundled_item_id IN (${placeholders})`,
    itemIds,
  );

  const metaByItem = new Map<number, Record<string, string>>();
  for (const id of itemIds) metaByItem.set(id, {});
  for (const row of metaRows) {
    const bag = metaByItem.get(Number(row.bundled_item_id)) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    metaByItem.set(Number(row.bundled_item_id), bag);
  }

  return rows.map((row) => {
    const bundledItemId = Number(row.bundled_item_id);
    const parsed = parseBundledItemMeta(metaByItem.get(bundledItemId) ?? {});
    return {
      bundledItemId,
      productId: Number(row.product_id),
      menuOrder: Number(row.menu_order),
      ...parsed,
    };
  });
}

export async function loadBundledCatalogItems(
  bundleId: number,
): Promise<BundledCatalogItem[]> {
  const redis = getRedis();
  const key = bundleCatalogCacheKey(bundleId);
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as BundledCatalogItem[];

  const items = await loadBundledCatalogItemsUncached(bundleId);
  await redis.set(key, JSON.stringify(items), "EX", catalogTtl());
  return items;
}

export async function getVariableBundledProductIds(
  productIds: number[],
): Promise<Set<number>> {
  const unique = [...new Set(productIds.filter((id) => id > 0))];
  const out = new Set<number>();
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<{ post_parent: number }[]>(
    `SELECT DISTINCT post_parent
     FROM ${t("posts")}
     WHERE post_parent IN (${placeholders})
       AND post_type = 'product_variation'
       AND post_status = 'publish'`,
    unique,
  );
  for (const row of rows) out.add(Number(row.post_parent));
  return out;
}

async function variationIdsForProduct(productId: number): Promise<number[]> {
  const rows = await query<{ ID: number }[]>(
    `SELECT ID FROM ${t("posts")}
     WHERE post_parent = ?
       AND post_type = 'product_variation'
       AND post_status = 'publish'
     ORDER BY menu_order ASC, ID ASC`,
    [productId],
  );
  return rows.map((r) => Number(r.ID));
}

function variationMatchesAttributes(
  meta: Record<string, string>,
  attrs: Array<{ name: string; option: string }>,
): boolean {
  for (const attr of attrs) {
    const keys = [
      `attribute_${attr.name}`,
      `attribute_pa_${attr.name.replace(/^pa_/, "")}`,
    ];
    if (attr.name.startsWith("pa_")) {
      keys.push(`attribute_${attr.name}`);
    }
    const expected = attr.option.trim().toLowerCase();
    let matched = false;
    for (const key of keys) {
      const actual = String(meta[key] ?? "").trim().toLowerCase();
      if (actual && actual === expected) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return attrs.length > 0;
}

async function resolveBundledVariation(
  item: BundledCatalogItem,
  override?: Pick<WcBundleConfigurationEntry, "variation_id" | "attributes">,
  variableProductIds?: Set<number>,
): Promise<Pick<WcBundleConfigurationEntry, "variation_id" | "attributes">> {
  if (override?.variation_id) {
    const out: Pick<WcBundleConfigurationEntry, "variation_id" | "attributes"> =
      { variation_id: override.variation_id };
    if (override.attributes?.length) out.attributes = override.attributes;
    return out;
  }

  if (variableProductIds && !variableProductIds.has(item.productId)) {
    return {};
  }

  const variationIds = await variationIdsForProduct(item.productId);
  if (!variationIds.length) return {};

  let attrs = override?.attributes ?? [];
  if (
    !attrs.length &&
    item.overrideDefaultVariationAttributes &&
    item.defaultVariationAttributes.length
  ) {
    attrs = item.defaultVariationAttributes;
  }

  const candidates =
    item.allowedVariationIds.length > 0
      ? variationIds.filter((id) => item.allowedVariationIds.includes(id))
      : variationIds;

  const searchIds = candidates.length ? candidates : variationIds;
  if (attrs.length) {
    const metaMap = await getPostMetaMany(searchIds);
    for (const varId of searchIds) {
      const meta = metaMap.get(varId) ?? {};
      if (variationMatchesAttributes(meta, attrs)) {
        return {
          variation_id: varId,
          attributes: attrs.map((a) => ({ name: a.name, option: a.option })),
        };
      }
    }
  }

  const fallbackId = searchIds[0];
  if (!fallbackId) return {};
  const metaMap = await getPostMetaMany([fallbackId]);
  const meta = metaMap.get(fallbackId) ?? {};
  const fromMeta: Array<{ name: string; option: string }> = [];
  for (const [key, raw] of Object.entries(meta)) {
    if (!key.startsWith("attribute_")) continue;
    const value = String(raw ?? "").trim();
    if (!value) continue;
    fromMeta.push({ name: key.slice("attribute_".length), option: value });
  }
  return {
    variation_id: fallbackId,
    attributes: fromMeta.length ? fromMeta : undefined,
  };
}

export type CartBundleOverride = Partial<
  Pick<
    WcBundleConfigurationEntry,
    | "bundled_item_id"
    | "product_id"
    | "quantity"
    | "optional_selected"
    | "variation_id"
    | "attributes"
  >
> & { bundled_item_id: number };

export function parseBundleConfigurationOverrides(
  extraData: CartExtraData[],
): CartBundleOverride[] | null {
  const raw = extraData.find((e) => e.key === "bundle_configuration")?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: CartBundleOverride[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const bundledItemId = Number(
        (row as { bundled_item_id?: number }).bundled_item_id,
      );
      if (!bundledItemId) continue;
      out.push({
        bundled_item_id: bundledItemId,
        product_id: Number((row as { product_id?: number }).product_id) || undefined,
        quantity: Number((row as { quantity?: number }).quantity) || undefined,
        optional_selected: (row as { optional_selected?: boolean })
          .optional_selected,
        variation_id:
          Number((row as { variation_id?: number }).variation_id) || undefined,
        attributes: Array.isArray((row as { attributes?: unknown }).attributes)
          ? ((row as { attributes: Array<{ name: string; option: string }> })
              .attributes)
          : undefined,
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export async function buildBundleConfigurationForLine(
  catalog: BundledCatalogItem[],
  _parentQuantity: number,
  extraData: CartExtraData[],
  options?: { variableProductIds?: Set<number> },
): Promise<WcBundleConfigurationEntry[]> {
  if (!catalog.length) return [];

  let variableProductIds = options?.variableProductIds;
  if (!variableProductIds) {
    variableProductIds = await getVariableBundledProductIds(
      catalog.map((c) => c.productId),
    );
  }

  const overrides = parseBundleConfigurationOverrides(extraData);
  const overrideByItemId = new Map<number, CartBundleOverride>();
  if (overrides) {
    for (const row of overrides) overrideByItemId.set(row.bundled_item_id, row);
  }

  const entries: WcBundleConfigurationEntry[] = [];

  for (const item of catalog) {
    const override = overrideByItemId.get(item.bundledItemId);
    const optionalSelected =
      override?.optional_selected ??
      (item.optional ? false : true);

    if (item.optional && !optionalSelected) continue;

    const perBundleQty = Math.max(
      1,
      override?.quantity ?? item.quantityMin,
    );
    // WC Product Bundles multiplies bundled quantities by the parent line qty.
    const entry: WcBundleConfigurationEntry = {
      bundled_item_id: item.bundledItemId,
      product_id: override?.product_id ?? item.productId,
      quantity: perBundleQty,
    };
    if (item.optional) entry.optional_selected = true;

    const variation = await resolveBundledVariation(
      item,
      override,
      variableProductIds,
    );
    if (variation.variation_id) entry.variation_id = variation.variation_id;
    if (variation.attributes?.length) entry.attributes = variation.attributes;

    entries.push(entry);
  }

  return entries;
}

export async function loadBundleCatalogByProductIds(
  bundleProductIds: number[],
): Promise<Map<number, BundledCatalogItem[]>> {
  const out = new Map<number, BundledCatalogItem[]>();
  for (const id of bundleProductIds) {
    out.set(id, await loadBundledCatalogItems(id));
  }
  return out;
}

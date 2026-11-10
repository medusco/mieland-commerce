import { query, t } from "../db/mysql.js";

export type ProductFaqItem = {
  title: string;
  content: string;
};

const FAQ_META_KEY_RE =
  /^product_faq(_[0-9]+_(title|content))?$/;

/** True when meta_key is the ACF product_faq count or a title/content row (not `_…` refs). */
export function isProductFaqMetaKey(key: string): boolean {
  return FAQ_META_KEY_RE.test(key);
}

/**
 * Parse ACF repeater `product_faq` from postmeta.
 * `product_faq` = row count N; rows are `product_faq_{i}_title` / `product_faq_{i}_content`.
 * Returns [] when count is missing/invalid. Skips rows where both fields are blank.
 * Does not invent rows for indices with no keys present.
 */
export function parseProductFaq(
  meta: Record<string, string>,
): ProductFaqItem[] {
  const rawCount = meta.product_faq;
  if (rawCount === undefined || rawCount === null || String(rawCount).trim() === "") {
    return [];
  }
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
    return [];
  }

  const items: ProductFaqItem[] = [];
  for (let i = 0; i < count; i++) {
    const titleKey = `product_faq_${i}_title`;
    const contentKey = `product_faq_${i}_content`;
    const hasTitle = Object.prototype.hasOwnProperty.call(meta, titleKey);
    const hasContent = Object.prototype.hasOwnProperty.call(meta, contentKey);
    if (!hasTitle && !hasContent) continue;

    const title = (meta[titleKey] ?? "").trim();
    const content = (meta[contentKey] ?? "").trim();
    if (!title && !content) continue;

    items.push({
      title: meta[titleKey] ?? "",
      content: meta[contentKey] ?? "",
    });
  }
  return items;
}

/**
 * Pure FAQ resolution: variations inherit from parent product meta.
 * Used by the GraphQL resolver and unit tests (no DB).
 */
export function resolveFaqItems(args: {
  isVariation: boolean;
  ownMeta: Record<string, string>;
  parentMeta?: Record<string, string> | null;
}): ProductFaqItem[] {
  if (args.isVariation) {
    return parseProductFaq(args.parentMeta ?? {});
  }
  return parseProductFaq(args.ownMeta);
}

/**
 * Resolve which post holds FAQ meta for each product id.
 * Variations inherit from their parent product post.
 */
export async function resolveProductFaqSourceIds(
  productIds: number[],
): Promise<Map<number, number>> {
  const unique = [
    ...new Set(productIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const sourceById = new Map<number, number>();
  for (const id of unique) sourceById.set(id, id);
  if (!unique.length) return sourceById;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<
    { ID: number; post_type: string; post_parent: number }[]
  >(
    `SELECT ID, post_type, post_parent FROM ${t("posts")}
     WHERE ID IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    const id = Number(row.ID);
    if (
      row.post_type === "product_variation" &&
      Number(row.post_parent) > 0
    ) {
      sourceById.set(id, Number(row.post_parent));
    } else {
      sourceById.set(id, id);
    }
  }
  return sourceById;
}

/** Load only product_faq* postmeta keys (excl. underscore ACF refs) for many posts. */
export async function getProductFaqMetaMany(
  postIds: number[],
): Promise<Map<number, Record<string, string>>> {
  const unique = [
    ...new Set(postIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, Record<string, string>>();
  for (const id of unique) out.set(id, {});
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<
    { post_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT post_id, meta_key, meta_value FROM ${t("postmeta")}
     WHERE post_id IN (${placeholders})
       AND meta_key REGEXP '^product_faq(_[0-9]+_(title|content))?$'`,
    unique,
  );
  for (const row of rows) {
    const id = Number(row.post_id);
    const bag = out.get(id) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    out.set(id, bag);
  }
  return out;
}

/**
 * Batch-load product FAQ items. Variations resolve through the parent product.
 * One posts lookup + one REGEXP postmeta query — safe for product lists.
 */
export async function getProductFaqMany(
  productIds: number[],
): Promise<Map<number, ProductFaqItem[]>> {
  const unique = [
    ...new Set(productIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, ProductFaqItem[]>();
  for (const id of unique) out.set(id, []);
  if (!unique.length) return out;

  const sourceById = await resolveProductFaqSourceIds(unique);
  const sourceIds = [...new Set([...sourceById.values()])];
  const metaBySource = await getProductFaqMetaMany(sourceIds);

  for (const id of unique) {
    const sourceId = sourceById.get(id) ?? id;
    const isVariation = sourceId !== id;
    out.set(
      id,
      resolveFaqItems({
        isVariation,
        ownMeta: metaBySource.get(id) ?? {},
        parentMeta: metaBySource.get(sourceId) ?? {},
      }),
    );
  }
  return out;
}

/**
 * Resolve FAQ for a GraphQL product node.
 * Prefers a pre-hydrated `faq` array (product list batch path).
 * Parent products with full `_acfMeta` (includes `product_faq` key or complete bag) parse in-process.
 * Variations inherit from parent meta when provided, otherwise the batched MySQL path.
 */
export async function resolveProductFaq(product: {
  databaseId?: number | null;
  parentDatabaseId?: number | null;
  __typename?: string | null;
  faq?: ProductFaqItem[] | null;
  _acfMeta?: Record<string, string>;
  /** Parent product_faq* meta when already available (tests / preloaded shapes). */
  parentFaqMeta?: Record<string, string> | null;
  /** True when `_acfMeta` came from full getPostMetaMany (not lean key subset). */
  _postMetaComplete?: boolean;
}): Promise<ProductFaqItem[]> {
  if (Array.isArray(product.faq)) return product.faq;

  const id = product.databaseId;
  if (!id) return [];

  const isVariation =
    product.__typename === "ProductVariation" ||
    (product.parentDatabaseId != null && product.parentDatabaseId > 0);

  if (isVariation) {
    if (product.parentFaqMeta) {
      return parseProductFaq(product.parentFaqMeta);
    }
    const map = await getProductFaqMany([id]);
    return map.get(id) ?? [];
  }

  if (product._acfMeta) {
    const meta = product._acfMeta;
    const hasFaqKeys =
      Object.prototype.hasOwnProperty.call(meta, "product_faq") ||
      Object.keys(meta).some((k) => k.startsWith("product_faq_"));
    if (hasFaqKeys || product._postMetaComplete) {
      return parseProductFaq(meta);
    }
  }

  const map = await getProductFaqMany([id]);
  return map.get(id) ?? [];
}

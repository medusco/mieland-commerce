import { query, t, type SqlParam } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";
import { toGlobalId } from "../utils/index.js";
import {
  productListIsLean,
  type ProductListNeeds,
} from "../utils/selection.js";
import { buildMediaItemUrl, getMediaBaseUrl } from "./media.js";

export type ProductRow = {
  ID: number;
  post_title: string;
  post_name: string;
  post_content: string;
  post_excerpt: string;
  post_type: string;
  post_status: string;
  post_parent: number;
};

function catalogTtl(): number {
  return loadConfig().CATALOG_CACHE_TTL_SECONDS;
}

function metaCacheKey(postId: number): string {
  return `postmeta:${postId}`;
}

function productCacheKey(productId: number): string {
  return `product:${productId}`;
}

async function cachedJson<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await loader();
  await redis.set(key, JSON.stringify(value), "EX", ttl);
  return value;
}

/** Batch-load postmeta for many posts (Redis cache + one IN query for misses). */
export async function getPostMetaMany(
  postIds: number[],
): Promise<Map<number, Record<string, string>>> {
  const unique = [...new Set(postIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, Record<string, string>>();
  if (!unique.length) return out;

  const redis = getRedis();
  const ttl = catalogTtl();
  const keys = unique.map(metaCacheKey);
  const cached = await redis.mget(...keys);
  const missing: number[] = [];

  for (let i = 0; i < unique.length; i++) {
    const raw = cached[i];
    if (raw) {
      out.set(unique[i], JSON.parse(raw) as Record<string, string>);
    } else {
      missing.push(unique[i]);
    }
  }

  if (missing.length) {
    const placeholders = missing.map(() => "?").join(",");
    const rows = await query<
      { post_id: number; meta_key: string; meta_value: string }[]
    >(
      `SELECT post_id, meta_key, meta_value FROM ${t("postmeta")}
       WHERE post_id IN (${placeholders})`,
      missing,
    );
    const grouped = new Map<number, Record<string, string>>();
    for (const id of missing) grouped.set(id, {});
    for (const row of rows) {
      const bag = grouped.get(Number(row.post_id)) ?? {};
      bag[row.meta_key] = row.meta_value ?? "";
      grouped.set(Number(row.post_id), bag);
    }
    const pipeline = redis.pipeline();
    for (const [id, meta] of grouped) {
      out.set(id, meta);
      pipeline.set(metaCacheKey(id), JSON.stringify(meta), "EX", ttl);
    }
    await pipeline.exec();
  }

  return out;
}

export async function getPostMeta(
  postId: number,
): Promise<Record<string, string>> {
  const map = await getPostMetaMany([postId]);
  return map.get(postId) ?? {};
}

/** Batch-load only specific meta keys (no full-row dump, no Redis full-meta cache). */
export async function getPostMetaKeysMany(
  postIds: number[],
  keys: string[],
): Promise<Map<number, Record<string, string>>> {
  const unique = [...new Set(postIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, Record<string, string>>();
  for (const id of unique) out.set(id, {});
  if (!unique.length || !keys.length) return out;

  const idPh = unique.map(() => "?").join(",");
  const keyPh = keys.map(() => "?").join(",");
  const rows = await query<
    { post_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT post_id, meta_key, meta_value FROM ${t("postmeta")}
     WHERE post_id IN (${idPh}) AND meta_key IN (${keyPh})`,
    [...unique, ...keys],
  );
  for (const row of rows) {
    const bag = out.get(Number(row.post_id)) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    out.set(Number(row.post_id), bag);
  }
  return out;
}

export async function getProductPrices(
  productIds: number[],
): Promise<Map<number, number>> {
  const metaMap = await getPostMetaKeysMany(productIds, [
    "_price",
    "_regular_price",
    "_sale_price",
  ]);
  const prices = new Map<number, number>();
  for (const id of productIds) {
    const meta = metaMap.get(id) ?? {};
    const sale = meta._sale_price;
    const regular = meta._regular_price || meta._price;
    if (sale && Number(sale) > 0) prices.set(id, Number(sale));
    else prices.set(id, Number(regular || meta._price || 0));
  }
  return prices;
}

export async function getProductPrice(productId: number): Promise<number> {
  const prices = await getProductPrices([productId]);
  return prices.get(productId) ?? 0;
}

export async function getStockStatus(productId: number): Promise<string> {
  const meta = await getPostMeta(productId);
  return (meta._stock_status || "instock").toLowerCase();
}

export type StockInfo = {
  status: string;
  manageStock: boolean;
  stockQuantity: number | null;
  allowsBackorders: boolean;
};

export async function getStockInfo(productId: number): Promise<StockInfo> {
  const meta = await getPostMeta(productId);
  const manageStock = (meta._manage_stock || "no").toLowerCase() === "yes";
  const backorders = (meta._backorders || "no").toLowerCase();
  const raw = meta._stock;
  const stockQuantity =
    manageStock && raw !== undefined && raw !== ""
      ? Number(raw)
      : null;
  return {
    status: (meta._stock_status || "instock").toLowerCase(),
    manageStock,
    stockQuantity: stockQuantity != null && Number.isFinite(stockQuantity)
      ? stockQuantity
      : null,
    allowsBackorders: backorders === "yes" || backorders === "notify",
  };
}

export async function getAttachmentUrl(id: number): Promise<{
  sourceUrl: string;
  mediaItemUrl: string;
  altText: string;
} | null> {
  if (!id) return null;
  const map = await getAttachmentUrls([id]);
  return map.get(id) ?? null;
}

async function getAttachmentUrls(
  ids: number[],
): Promise<Map<number, { sourceUrl: string; mediaItemUrl: string; altText: string }>> {
  const unique = [...new Set(ids.filter((id) => id > 0))];
  const out = new Map<
    number,
    { sourceUrl: string; mediaItemUrl: string; altText: string }
  >();
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const [rows, metaMap, mediaBaseUrl] = await Promise.all([
    query<{ ID: number; guid: string; post_title: string }[]>(
      `SELECT ID, guid, post_title FROM ${t("posts")} WHERE ID IN (${placeholders})`,
      unique,
    ),
    getPostMetaMany(unique),
    getMediaBaseUrl(),
  ]);
  for (const row of rows) {
    const meta = metaMap.get(row.ID) ?? {};
    const url = buildMediaItemUrl(meta._wp_attached_file, row.guid, mediaBaseUrl);
    out.set(row.ID, {
      sourceUrl: url,
      mediaItemUrl: url,
      altText: meta._wp_attachment_image_alt || row.post_title || "",
    });
  }
  return out;
}

export async function listProducts(args: {
  first?: number;
  include?: number[] | null;
  status?: string;
  needs?: ProductListNeeds;
}): Promise<unknown[]> {
  const cfg = loadConfig();
  const first = Math.min(args.first ?? 100, 100);
  const status = args.status || "publish";
  const needs: ProductListNeeds = args.needs ?? {
    price: true,
    images: true,
    categories: true,
    attributes: true,
    variations: true,
    content: true,
    reviews: true,
    stock: true,
    featured: true,
  };
  const lean = productListIsLean(needs);
  const cacheKey = `products:${lean ? "lean" : "full"}:${status}:${(args.include ?? []).join(",")}:${first}`;

  return cachedJson(cacheKey, cfg.CATALOG_CACHE_TTL_SECONDS, async () => {
    let sql = lean
      ? `SELECT ID, post_title, post_name, post_type, post_status, post_parent
         FROM ${t("posts")}
         WHERE post_type = 'product' AND post_status = ?`
      : `SELECT ID, post_title, post_name, post_content, post_excerpt, post_type, post_status, post_parent
         FROM ${t("posts")}
         WHERE post_type = 'product' AND post_status = ?`;
    const params: SqlParam[] = [status];
    if (args.include?.length) {
      sql += ` AND ID IN (${args.include.map(() => "?").join(",")})`;
      params.push(...args.include);
    }
    sql += ` ORDER BY post_date DESC LIMIT ?`;
    params.push(first);
    const rows = await query<ProductRow[]>(sql, params);
    return lean ? shapeProductsLean(rows, needs) : shapeProducts(rows, needs);
  });
}

/** Lean list: posts + optional price keys + typename. No variations/images/categories. */
async function shapeProductsLean(
  rows: ProductRow[],
  needs: ProductListNeeds,
): Promise<unknown[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.ID);
  const metaKeys: string[] = [];
  if (needs.price) metaKeys.push("_price", "_regular_price", "_sale_price");
  if (needs.stock) metaKeys.push("_stock_status", "_stock", "_manage_stock");
  if (needs.featured) metaKeys.push("_featured");

  const [metaMap, variableIds] = await Promise.all([
    metaKeys.length
      ? getPostMetaKeysMany(ids, metaKeys)
      : Promise.resolve(new Map<number, Record<string, string>>()),
    variableParentIds(ids),
  ]);

  return rows.map((row) => {
    const meta = metaMap.get(row.ID) ?? {};
    const isVariable = variableIds.has(row.ID);
    const price = meta._price ?? "";
    const regularPrice = meta._regular_price ?? price;
    const salePrice = meta._sale_price ?? "";
    const manageStock = needs.stock
      ? (meta._manage_stock || "no").toLowerCase() === "yes"
      : false;
    const stockQuantity =
      needs.stock && manageStock && meta._stock !== undefined && meta._stock !== ""
        ? Number(meta._stock)
        : null;
    return {
      __typename: isVariable ? "VariableProduct" : "SimpleProduct",
      id: toGlobalId("product", row.ID),
      databaseId: row.ID,
      name: row.post_title,
      slug: row.post_name,
      uri: `/product/${row.post_name}/`,
      description: "",
      shortDescription: "",
      featured: needs.featured ? meta._featured === "yes" : false,
      averageRating: 0,
      reviewCount: 0,
      onSale: Boolean(salePrice && Number(salePrice) > 0),
      stockStatus: needs.stock
        ? (meta._stock_status || "IN_STOCK").toUpperCase().replace("-", "_")
        : "IN_STOCK",
      stockQuantity:
        stockQuantity != null && Number.isFinite(stockQuantity) ? stockQuantity : null,
      manageStock,
      image: null,
      thumbnailFields: { productThumbnailImage: null },
      attributes: { nodes: [] },
      price: needs.price ? price : "",
      regularPrice: needs.price ? regularPrice : "",
      salePrice: needs.price && salePrice ? salePrice : null,
      productCategories: { nodes: [] },
      galleryImages: { nodes: [] },
      reviews: { averageRating: 0, edges: [] },
      variations: { nodes: [] },
    };
  });
}

async function variableParentIds(productIds: number[]): Promise<Set<number>> {
  if (!productIds.length) return new Set();
  const placeholders = productIds.map(() => "?").join(",");
  const rows = await query<{ post_parent: number }[]>(
    `SELECT DISTINCT post_parent FROM ${t("posts")}
     WHERE post_parent IN (${placeholders})
       AND post_type = 'product_variation'
       AND post_status IN ('publish','private')`,
    productIds,
  );
  return new Set(rows.map((r) => Number(r.post_parent)));
}

async function getProductCategoriesMany(
  productIds: number[],
): Promise<Map<number, Array<{ name: string; slug: string }>>> {
  const out = new Map<number, Array<{ name: string; slug: string }>>();
  for (const id of productIds) out.set(id, []);
  if (!productIds.length) return out;

  const placeholders = productIds.map(() => "?").join(",");
  const rows = await query<{ object_id: number; name: string; slug: string }[]>(
    `SELECT tr.object_id, terms.name, terms.slug
     FROM ${t("term_relationships")} tr
     JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tr.object_id IN (${placeholders}) AND tt.taxonomy = 'product_cat'`,
    productIds,
  );
  for (const row of rows) {
    const list = out.get(Number(row.object_id)) ?? [];
    list.push({ name: row.name, slug: row.slug });
    out.set(Number(row.object_id), list);
  }
  return out;
}

async function getVariationsMany(
  parentIds: number[],
  metaMap: Map<number, Record<string, string>>,
): Promise<Map<number, unknown[]>> {
  const out = new Map<number, unknown[]>();
  for (const id of parentIds) out.set(id, []);
  if (!parentIds.length) return out;

  const placeholders = parentIds.map(() => "?").join(",");
  const rows = await query<ProductRow[]>(
    `SELECT ID, post_title, post_name, post_content, post_excerpt, post_type, post_status, post_parent
     FROM ${t("posts")}
     WHERE post_parent IN (${placeholders})
       AND post_type = 'product_variation'
       AND post_status IN ('publish','private')
     ORDER BY menu_order ASC, ID ASC`,
    parentIds,
  );

  const varIds = rows.map((r) => r.ID);
  const varMeta = await getPostMetaMany(varIds);
  for (const [id, meta] of varMeta) metaMap.set(id, meta);

  const thumbIds = varIds
    .map((id) => Number((varMeta.get(id) ?? {})._thumbnail_id || 0))
    .filter((id) => id > 0);
  const images = await getAttachmentUrls(thumbIds);

  for (const r of rows) {
    const meta = varMeta.get(r.ID) ?? {};
    const imageId = Number(meta._thumbnail_id || 0);
    const list = out.get(r.post_parent) ?? [];
    list.push({
      databaseId: r.ID,
      name: r.post_title,
      price: meta._price ?? "",
      regularPrice: meta._regular_price ?? meta._price ?? "",
      salePrice: meta._sale_price || null,
      onSale: Boolean(meta._sale_price),
      image: imageId ? images.get(imageId) ?? null : null,
    });
    out.set(r.post_parent, list);
  }
  return out;
}

async function getProductAttributesAsync(
  meta: Record<string, string>,
): Promise<Array<{ name: string; label: string; options: string[] }>> {
  const raw = meta._product_attributes;
  if (!raw) return [];
  try {
    const { phpUnserialize } = await import("./options.js");
    const parsed = phpUnserialize(raw) as Record<
      string,
      { name?: string; value?: string }
    >;
    if (!parsed || typeof parsed !== "object") return [];
    return Object.values(parsed).map((a) => ({
      name: a.name ?? "",
      label: a.name ?? "",
      options: String(a.value ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
    }));
  } catch {
    return [];
  }
}

async function shapeProducts(
  rows: ProductRow[],
  needs: ProductListNeeds,
): Promise<unknown[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.ID);
  const metaMap = await getPostMetaMany(ids);
  const variableIds = await variableParentIds(ids);

  const [categories, images, variations] = await Promise.all([
    needs.categories
      ? getProductCategoriesMany(ids)
      : Promise.resolve(new Map<number, Array<{ name: string; slug: string }>>()),
    needs.images
      ? getAttachmentUrls(
          ids
            .map((id) => Number((metaMap.get(id) ?? {})._thumbnail_id || 0))
            .filter((id) => id > 0),
        )
      : Promise.resolve(
          new Map<
            number,
            { sourceUrl: string; mediaItemUrl: string; altText: string }
          >(),
        ),
    needs.variations
      ? getVariationsMany(
          ids.filter((id) => variableIds.has(id)),
          metaMap,
        )
      : Promise.resolve(new Map<number, unknown[]>()),
  ]);

  const out = [];
  for (const row of rows) {
    const meta = metaMap.get(row.ID) ?? {};
    const isVariable = variableIds.has(row.ID);
    const imageId = Number(meta._thumbnail_id || 0);
    const image = needs.images && imageId ? images.get(imageId) ?? null : null;
    const price = meta._price ?? "";
    const regularPrice = meta._regular_price ?? price;
    const salePrice = meta._sale_price ?? "";
    const onSale = Boolean(salePrice && Number(salePrice) > 0);
    const attrs = needs.attributes
      ? await getProductAttributesAsync(meta)
      : [];
    const manageStock = needs.stock
      ? (meta._manage_stock || "no").toLowerCase() === "yes"
      : false;
    const stockQtyRaw =
      needs.stock && manageStock && meta._stock !== undefined && meta._stock !== ""
        ? Number(meta._stock)
        : null;

    const base = {
      __typename: isVariable ? "VariableProduct" : "SimpleProduct",
      id: toGlobalId("product", row.ID),
      databaseId: row.ID,
      name: row.post_title,
      slug: row.post_name,
      uri: `/product/${row.post_name}/`,
      description: needs.content ? row.post_content : "",
      shortDescription: needs.content ? row.post_excerpt : "",
      featured: needs.featured ? meta._featured === "yes" : false,
      averageRating: needs.reviews ? Number(meta._wc_average_rating || 0) : 0,
      reviewCount: needs.reviews ? Number(meta._wc_review_count || 0) : 0,
      onSale,
      stockStatus: needs.stock
        ? (meta._stock_status || "IN_STOCK").toUpperCase().replace("-", "_")
        : "IN_STOCK",
      stockQuantity:
        stockQtyRaw != null && Number.isFinite(stockQtyRaw) ? stockQtyRaw : null,
      manageStock,
      image,
      thumbnailFields: {
        productThumbnailImage: image
          ? {
              node: {
                mediaItemUrl: image.mediaItemUrl,
                sourceUrl: image.sourceUrl,
                altText: image.altText,
              },
            }
          : null,
      },
      attributes: { nodes: attrs },
      price: needs.price ? price : "",
      regularPrice: needs.price ? regularPrice : "",
      salePrice: needs.price && salePrice ? salePrice : null,
      productCategories: { nodes: categories.get(row.ID) ?? [] },
      galleryImages: { nodes: [] as unknown[] },
      reviews: {
        averageRating: needs.reviews ? Number(meta._wc_average_rating || 0) : 0,
        edges: [],
      },
    };

    if (isVariable && needs.variations) {
      out.push({
        ...base,
        variations: { nodes: variations.get(row.ID) ?? [] },
      });
    } else {
      out.push({
        ...base,
        variations: { nodes: [] },
      });
    }
  }
  return out;
}

export async function getProductNodes(
  productIds: readonly number[],
): Promise<Array<unknown | null>> {
  const ids = [...productIds];
  if (!ids.length) return [];

  const redis = getRedis();
  const ttl = catalogTtl();
  const keys = ids.map(productCacheKey);
  const cached = await redis.mget(...keys);
  const results: Array<unknown | null> = new Array(ids.length).fill(null);
  const missingIdx: number[] = [];

  for (let i = 0; i < ids.length; i++) {
    const raw = cached[i];
    if (raw) results[i] = JSON.parse(raw);
    else missingIdx.push(i);
  }

  if (!missingIdx.length) return results;

  const missingIds = missingIdx.map((i) => ids[i]);
  const placeholders = missingIds.map(() => "?").join(",");
  const rows = await query<ProductRow[]>(
    `SELECT ID, post_title, post_name, post_content, post_excerpt, post_type, post_status, post_parent
     FROM ${t("posts")} WHERE ID IN (${placeholders})`,
    missingIds,
  );
  const byId = new Map(rows.map((r) => [r.ID, r]));

  const variationRows = rows.filter((r) => r.post_type === "product_variation");
  const productRows = rows.filter((r) => r.post_type !== "product_variation");

  const shapedProducts = await shapeProducts(productRows, {
    price: true,
    images: true,
    categories: true,
    attributes: true,
    variations: true,
    content: true,
    reviews: true,
    stock: true,
    featured: true,
  });
  const shapedById = new Map<number, unknown>();
  for (const node of shapedProducts) {
    const id = (node as { databaseId: number }).databaseId;
    shapedById.set(id, node);
  }

  if (variationRows.length) {
    const varMeta = await getPostMetaMany(variationRows.map((r) => r.ID));
    const thumbIds = variationRows
      .map((r) => Number((varMeta.get(r.ID) ?? {})._thumbnail_id || 0))
      .filter((id) => id > 0);
    const images = await getAttachmentUrls(thumbIds);
    for (const row of variationRows) {
      const meta = varMeta.get(row.ID) ?? {};
      const imageId = Number(meta._thumbnail_id || 0);
      shapedById.set(row.ID, {
        databaseId: row.ID,
        name: row.post_title,
        image: imageId ? images.get(imageId) ?? null : null,
        price: meta._price ?? "",
        regularPrice: meta._regular_price ?? "",
        salePrice: meta._sale_price || null,
        onSale: Boolean(meta._sale_price),
      });
    }
  }

  const pipeline = redis.pipeline();
  for (const i of missingIdx) {
    const id = ids[i];
    const node = byId.has(id) ? shapedById.get(id) ?? null : null;
    results[i] = node;
    if (node) pipeline.set(productCacheKey(id), JSON.stringify(node), "EX", ttl);
  }
  await pipeline.exec();

  return results;
}

export async function getProductNode(productId: number) {
  const [node] = await getProductNodes([productId]);
  return node ?? null;
}

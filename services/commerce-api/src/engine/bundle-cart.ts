import type { CartExtraData } from "./types.js";

export type CartLineBundleMeta = {
  isBundledItem: boolean;
  bundledByCartKey: string | null;
  bundleContainerStamp: string | null;
};

function normalizeExtraDataKey(key: string): string {
  return key.trim().replace(/^_+/, "").toLowerCase();
}

function extraDataEntryValue(
  extraData: CartExtraData[],
  key: string,
): string | null {
  const target = normalizeExtraDataKey(key);
  for (const entry of extraData) {
    const entryKey = entry.key?.trim();
    if (!entryKey || normalizeExtraDataKey(entryKey) !== target) continue;
    const value = entry.value?.trim();
    if (value) return value;
  }
  return null;
}

export function bundledByCartKeyFromExtraData(
  extraData: CartExtraData[],
): string | null {
  return extraDataEntryValue(extraData, "bundled_by");
}

export function bundleContainerStampFromExtraData(
  extraData: CartExtraData[],
): string | null {
  return extraDataEntryValue(extraData, "stamp");
}

export function isBundledCartLineFromExtraData(
  extraData: CartExtraData[],
): boolean {
  return Boolean(
    bundledByCartKeyFromExtraData(extraData) ||
      extraDataEntryValue(extraData, "bundled_item_id") ||
      extraDataEntryValue(extraData, "bundled_item"),
  );
}

export function cartLineBundleMeta(extraData: CartExtraData[]): CartLineBundleMeta {
  return {
    isBundledItem: isBundledCartLineFromExtraData(extraData),
    bundledByCartKey: bundledByCartKeyFromExtraData(extraData),
    bundleContainerStamp: bundleContainerStampFromExtraData(extraData),
  };
}

function resolveParentCartKey(
  bundledBy: string | null | undefined,
  stampToParentKey: Map<string, string>,
): string | null {
  const ref = bundledBy?.trim();
  if (!ref) return null;
  return stampToParentKey.get(ref) ?? ref;
}

export type BundleCartLineRef = {
  key: string;
  extraData: CartExtraData[];
};

/** Maps parent cart line key → child line keys in cart order. */
export function bundledChildKeysByParentKey(
  lines: BundleCartLineRef[],
): Map<string, string[]> {
  const stampToParentKey = new Map<string, string>();
  for (const line of lines) {
    const meta = cartLineBundleMeta(line.extraData);
    if (meta.isBundledItem) continue;
    stampToParentKey.set(line.key, line.key);
    const stamp = meta.bundleContainerStamp?.trim();
    if (stamp) stampToParentKey.set(stamp, line.key);
  }

  const out = new Map<string, string[]>();
  let lastParentKey: string | null = null;

  for (const line of lines) {
    const meta = cartLineBundleMeta(line.extraData);
    if (meta.isBundledItem) {
      const parentKey = resolveParentCartKey(
        meta.bundledByCartKey,
        stampToParentKey,
      );
      const resolved = parentKey ?? lastParentKey;
      if (!resolved) continue;
      const list = out.get(resolved) ?? [];
      list.push(line.key);
      out.set(resolved, list);
      continue;
    }
    lastParentKey = line.key;
  }

  return out;
}

type MediaLike = {
  sourceUrl?: string | null;
  mediaItemUrl?: string | null;
  altText?: string | null;
};

type ProductLike = {
  name?: string | null;
  databaseId?: number | null;
  thumbnailFields?: {
    productThumbnailImage?: { node?: MediaLike | null } | null;
  } | null;
};

type VariationLike = {
  name?: string | null;
  databaseId?: number | null;
  image?: MediaLike | null;
};

function asProductLike(node: unknown): ProductLike | null {
  if (!node || typeof node !== "object") return null;
  return node as ProductLike;
}

export function bundledProductTitle(
  product: unknown,
  variation: unknown,
): string | null {
  const p = asProductLike(product);
  const v = asProductLike(variation) as VariationLike | null;
  const name =
    p?.name?.trim() ||
    v?.name?.trim() ||
    (p?.databaseId != null ? `Product #${p.databaseId}` : null);
  return name || null;
}

export function bundledProductImage(
  product: unknown,
  variation: unknown,
): MediaLike | null {
  const p = asProductLike(product);
  const v = asProductLike(variation) as VariationLike | null;
  const variationImage = v?.image;
  const fromVariation =
    variationImage?.sourceUrl?.trim() ||
    variationImage?.mediaItemUrl?.trim() ||
    null;
  if (fromVariation) {
    return {
      sourceUrl: variationImage?.sourceUrl?.trim() || fromVariation,
      mediaItemUrl: variationImage?.mediaItemUrl?.trim() || fromVariation,
      altText: variationImage?.altText?.trim() || null,
    };
  }

  const thumb = p?.thumbnailFields?.productThumbnailImage?.node;
  const src =
    thumb?.sourceUrl?.trim() || thumb?.mediaItemUrl?.trim() || null;
  if (!src) return null;
  return {
    sourceUrl: thumb?.sourceUrl?.trim() || src,
    mediaItemUrl: thumb?.mediaItemUrl?.trim() || src,
    altText: thumb?.altText?.trim() || null,
  };
}

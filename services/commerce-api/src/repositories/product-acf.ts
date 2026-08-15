import {
  loadAcfGraphqlGroups,
  shapeAcfGroupFields,
  type AcfGraphqlGroup,
} from "./acf-graphql.js";

let thumbnailGroupPromise: Promise<AcfGraphqlGroup | null> | null = null;

/** Cached ACF group for Product.thumbnailFields (loaded once at first use). */
export function getProductThumbnailAcfGroup(): Promise<AcfGraphqlGroup | null> {
  if (!thumbnailGroupPromise) {
    thumbnailGroupPromise = loadAcfGraphqlGroups().then(
      (groups) =>
        groups.find((group) => group.graphqlFieldName === "thumbnailFields") ??
        null,
    );
  }
  return thumbnailGroupPromise;
}

/** Postmeta keys required to shape thumbnailFields (ACF image field). */
export const PRODUCT_THUMBNAIL_META_KEYS = ["product_thumbnail_image"] as const;

export async function shapeProductThumbnailFields(
  meta: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const group = await getProductThumbnailAcfGroup();
  if (!group) return null;
  return shapeAcfGroupFields(meta, group);
}

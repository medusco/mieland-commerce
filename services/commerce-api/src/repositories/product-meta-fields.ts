import { unserializeAcf } from "./acf.js";

/** ACF postmeta keys for ProductMetaFields extras (ignore `_`-prefixed reference rows). */
export const PRODUCT_BADGE_META_KEY = "product_badge";
export const FLAVOURS_AVAILABLE_META_KEY = "flavours_available";

export type ProductMetaFieldExtras = {
  productBadge: string | null;
  flavoursAvailable: string | null;
};

function asTrimmedString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * Parse ACF `product_badge` text from postmeta.
 * Missing / blank → null. Underscore ACF field-key rows are never read.
 */
export function parseProductBadge(
  meta: Record<string, string>,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(meta, PRODUCT_BADGE_META_KEY)) {
    return null;
  }
  return asTrimmedString(meta[PRODUCT_BADGE_META_KEY]);
}

/**
 * Parse ACF `flavours_available` from postmeta as a nullable string.
 * Plain text is returned trimmed. PHP-serialized / JSON lists are joined with ", ".
 * Missing / blank / empty list → null.
 */
export function parseFlavoursAvailable(
  meta: Record<string, string>,
): string | null {
  if (
    !Object.prototype.hasOwnProperty.call(meta, FLAVOURS_AVAILABLE_META_KEY)
  ) {
    return null;
  }
  const raw = meta[FLAVOURS_AVAILABLE_META_KEY];
  if (raw == null || String(raw).trim() === "") return null;

  const parsed = unserializeAcf(String(raw));
  if (Array.isArray(parsed)) {
    const parts = parsed
      .map((item) => asTrimmedString(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : null;
  }
  if (parsed && typeof parsed === "object") {
    const parts = Object.values(parsed as Record<string, unknown>)
      .map((item) => asTrimmedString(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : null;
  }
  return asTrimmedString(parsed);
}

/** Pure extras resolution from a postmeta bag (variations use the same meta the group shaper sees). */
export function resolveProductMetaFieldExtras(
  meta: Record<string, string>,
): ProductMetaFieldExtras {
  return {
    productBadge: parseProductBadge(meta),
    flavoursAvailable: parseFlavoursAvailable(meta),
  };
}

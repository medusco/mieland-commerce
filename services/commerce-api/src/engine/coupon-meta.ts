/** WooCommerce postmeta — matches mieland-wordpress mu-plugin. */
export const IS_PERSONALIZED_COUPON_META = "is_personalized_coupon";

export function parseIsPersonalizedCoupon(
  meta: Record<string, string>,
): boolean {
  const raw =
    meta[IS_PERSONALIZED_COUPON_META] ??
    meta[`_mieland_${IS_PERSONALIZED_COUPON_META}`] ??
    "";
  if (!raw.trim()) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Woo `usage_count` postmeta — how many times the coupon has been redeemed. */
export function parseCouponUsageCount(raw: string | undefined | null): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Woo `usage_limit` postmeta. Empty / 0 / missing = unlimited (null).
 */
export function parseCouponUsageLimit(
  raw: string | undefined | null,
): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function isCouponUsageExhausted(
  usageCount: number,
  usageLimit: number | null,
): boolean {
  if (usageLimit == null) return false;
  return usageCount >= usageLimit;
}

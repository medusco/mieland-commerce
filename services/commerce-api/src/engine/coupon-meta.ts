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

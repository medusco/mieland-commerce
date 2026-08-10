/**
 * Ad-hoc: compare Woo coupon hold meta vs commerce usage formula.
 * Usage: node --import tsx scripts/probe-woo-vs-commerce.mjs [CODE] [email]
 * Do not commit probe output.
 */
import { closeMysql, query, t } from "../src/db/mysql.js";
import { isCouponUsageLimitReached } from "../src/engine/coupon-meta.js";
import { loadCoupon } from "../src/engine/shipping.js";
import {
  countActiveTentativeCouponHolds,
  countUsedByForAliases,
  resolveUsageAliases,
} from "../src/repositories/coupon-holds.js";

const code = (process.argv[2] || "MIELAND-A26B18680A").trim().toUpperCase();
const emailArg = (process.argv[3] || "jack.spektor@gmail.com").trim().toLowerCase();

async function main() {
  const coupon = await loadCoupon(code);
  if (!coupon) {
    console.log(JSON.stringify({ ok: false, error: "coupon_not_found", code }, null, 2));
    await closeMysql();
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const holdRows = await query(
    `SELECT meta_key, meta_value FROM ${t("postmeta")}
     WHERE post_id = ?
       AND (meta_key LIKE '_coupon_held_%'
         OR meta_key LIKE '_maybe_used_by_%'
         OR meta_key IN ('_used_by', 'used_by', 'usage_count', 'usage_limit',
           'usage_limit_per_user', 'mieland_personal_coupon_email', 'customer_email'))
     ORDER BY meta_key`,
    [coupon.id],
  );

  const activeHeld = holdRows.filter(
    (r) =>
      String(r.meta_key).startsWith("_coupon_held_") &&
      String(r.meta_key) > `_coupon_held_${now}`,
  );
  const activeMaybe = holdRows.filter(
    (r) =>
      String(r.meta_key).startsWith("_maybe_used_by_") &&
      String(r.meta_key) > `_maybe_used_by_${now}`,
  );
  const expiredHeld = holdRows.filter(
    (r) =>
      String(r.meta_key).startsWith("_coupon_held_") &&
      String(r.meta_key) <= `_coupon_held_${now}`,
  );
  const expiredMaybe = holdRows.filter(
    (r) =>
      String(r.meta_key).startsWith("_maybe_used_by_") &&
      String(r.meta_key) <= `_maybe_used_by_${now}`,
  );

  const aliases = await resolveUsageAliases({
    customerId: null,
    billingEmail: emailArg,
  });
  const holds = await countActiveTentativeCouponHolds(coupon.id, aliases);
  const usedBy = await countUsedByForAliases(coupon.id, aliases);

  const globalLimit = coupon.usageLimit ?? (coupon.isPersonalIssue ? 1 : null);
  const perUserLimit =
    coupon.usageLimitPerUser ?? (coupon.isPersonalIssue ? 1 : null);

  const globalBlocked = isCouponUsageLimitReached(
    coupon.usageCount,
    holds.global,
    globalLimit,
  );
  const perUserBlocked =
    perUserLimit != null &&
    isCouponUsageLimitReached(usedBy, holds.perUser, perUserLimit);

  const unpaidWithCoupon = await query(
    `SELECT o.id, o.status, oi.order_item_name, o.billing_email, o.customer_id
     FROM ${t("wc_orders")} o
     INNER JOIN ${t("woocommerce_order_items")} oi
       ON oi.order_id = o.id AND oi.order_item_type = 'coupon'
     WHERE o.type = 'shop_order'
       AND UPPER(oi.order_item_name) = ?
       AND o.status IN (
         'pending','failed','on-hold',
         'wc-pending','wc-failed','wc-on-hold'
       )
     ORDER BY o.id DESC
     LIMIT 20`,
    [code],
  );

  const recentOrdersSameEmail = await query(
    `SELECT o.id, o.status, o.billing_email, o.date_created_gmt
     FROM ${t("wc_orders")} o
     WHERE o.type = 'shop_order'
       AND LOWER(o.billing_email) = ?
     ORDER BY o.id DESC
     LIMIT 10`,
    [emailArg],
  );

  console.log(
    JSON.stringify(
      {
        code,
        couponId: coupon.id,
        emailArg,
        aliases,
        coupon: {
          usageCount: coupon.usageCount,
          usageLimit: coupon.usageLimit,
          usageLimitPerUser: coupon.usageLimitPerUser,
          usedByCount: coupon.usedByCount,
          isPersonalIssue: coupon.isPersonalIssue,
          emailRestrictions: coupon.emailRestrictions,
        },
        wooMeta: {
          now,
          activeHeld,
          activeMaybe,
          expiredHeldCount: expiredHeld.length,
          expiredMaybeCount: expiredMaybe.length,
          usedByRows: holdRows.filter((r) =>
            ["_used_by", "used_by"].includes(String(r.meta_key)),
          ),
        },
        commerceFormula: {
          holds,
          usedBy,
          globalLimit,
          perUserLimit,
          globalBlocked,
          perUserBlocked,
          wouldAllowApply: !globalBlocked && !perUserBlocked,
        },
        unpaidOrdersStillHoldingCouponLine: unpaidWithCoupon,
        recentOrdersSameEmail,
      },
      null,
      2,
    ),
  );

  await closeMysql();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeMysql();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

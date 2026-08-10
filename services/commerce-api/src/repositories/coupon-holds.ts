import { query, queryOne, t, type SqlParam } from "../db/mysql.js";
import { isCouponUsageLimitReached } from "../engine/coupon-meta.js";
import { loadCoupon } from "../engine/shipping.js";
import { findUserById, findUserByLoginOrEmail } from "../auth/index.js";

/** HPOS may store statuses with or without the `wc-` prefix. */
const UNPAID_STATUSES = [
  "pending",
  "failed",
  "on-hold",
  "wc-pending",
  "wc-failed",
  "wc-on-hold",
] as const;

/** Paid / finalized statuses that permanently consume a single-use coupon. */
const PAID_STATUSES = [
  "processing",
  "completed",
  "refunded",
  "partially-refunded",
  "wc-processing",
  "wc-completed",
  "wc-refunded",
  "wc-partially-refunded",
] as const;

export type UnpaidCouponHold = {
  orderId: number;
  code: string;
  status: string;
};

function normalizeCodes(couponCodes: string[]): string[] {
  return [
    ...new Set(
      couponCodes
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

function ownerFilter(args: {
  customerId?: number | null;
  billingEmail?: string | null;
}): {
  customerId: number | null;
  email: string | null;
  clause: string;
  params: SqlParam[];
} | null {
  const customerId =
    args.customerId != null && args.customerId > 0 ? args.customerId : null;
  const email = args.billingEmail?.trim().toLowerCase() || null;
  if (!customerId && !email) return null;

  if (customerId && email) {
    return {
      customerId,
      email,
      clause: "AND (o.customer_id = ? OR LOWER(o.billing_email) = ?)",
      params: [customerId, email],
    };
  }
  if (customerId) {
    return {
      customerId,
      email,
      clause: "AND o.customer_id = ?",
      params: [customerId],
    };
  }
  return {
    customerId,
    email,
    clause: "AND LOWER(o.billing_email) = ?",
    params: [email!],
  };
}

/**
 * WooCommerce holds usage-limited coupons on pending/failed/on-hold orders.
 * Find those unpaid orders for this customer/email so we can reject apply
 * instead of letting WC return a generic "usage limit reached" error.
 */
export async function findUnpaidOrdersHoldingCoupons(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<UnpaidCouponHold[]> {
  const codes = normalizeCodes(args.couponCodes);
  const owner = ownerFilter(args);
  if (!codes.length || !owner) return [];

  const codePlaceholders = codes.map(() => "?").join(",");
  const statusPlaceholders = UNPAID_STATUSES.map(() => "?").join(",");
  const params: SqlParam[] = [...UNPAID_STATUSES, ...codes, ...owner.params];

  const rows = await query<
    { id: number; status: string; order_item_name: string }[]
  >(
    `SELECT DISTINCT o.id, o.status, oi.order_item_name
     FROM ${t("wc_orders")} o
     INNER JOIN ${t("woocommerce_order_items")} oi
       ON oi.order_id = o.id AND oi.order_item_type = 'coupon'
     WHERE o.type = 'shop_order'
       AND o.status IN (${statusPlaceholders})
       AND UPPER(oi.order_item_name) IN (${codePlaceholders})
       ${owner.clause}
     ORDER BY o.id DESC`,
    params,
  );

  return rows.map((row) => ({
    orderId: Number(row.id),
    code: String(row.order_item_name ?? "").trim().toUpperCase(),
    status: String(row.status ?? "").replace(/^wc-/, ""),
  }));
}

/**
 * Reject apply/checkout when the code is tied to a failed or abandoned unpaid order.
 */
export async function assertCouponNotHeldByUnpaidOrder(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<void> {
  const holds = await findUnpaidOrdersHoldingCoupons(args);
  if (!holds.length) return;
  const code = holds[0]!.code;
  throw new Error(
    `Coupon "${code}" cannot be applied because it is already on an incomplete checkout. Complete or cancel that order first, then try again.`,
  );
}

export async function findPaidOrdersWithCoupons(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<UnpaidCouponHold[]> {
  const codes = normalizeCodes(args.couponCodes);
  const owner = ownerFilter(args);
  if (!codes.length || !owner) return [];

  const codePlaceholders = codes.map(() => "?").join(",");
  const statusPlaceholders = PAID_STATUSES.map(() => "?").join(",");
  const params: SqlParam[] = [...PAID_STATUSES, ...codes, ...owner.params];

  const rows = await query<
    { id: number; status: string; order_item_name: string }[]
  >(
    `SELECT DISTINCT o.id, o.status, oi.order_item_name
     FROM ${t("wc_orders")} o
     INNER JOIN ${t("woocommerce_order_items")} oi
       ON oi.order_id = o.id AND oi.order_item_type = 'coupon'
     WHERE o.type = 'shop_order'
       AND o.status IN (${statusPlaceholders})
       AND UPPER(oi.order_item_name) IN (${codePlaceholders})
       ${owner.clause}
     ORDER BY o.id DESC
     LIMIT 1`,
    params,
  );

  return rows.map((row) => ({
    orderId: Number(row.id),
    code: String(row.order_item_name ?? "").trim().toUpperCase(),
    status: String(row.status ?? "").replace(/^wc-/, ""),
  }));
}

/** Reject when the coupon was already redeemed on a paid order. */
export async function assertCouponNotRedeemedOnPaidOrder(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<void> {
  const paid = await findPaidOrdersWithCoupons(args);
  if (!paid.length) return;
  throw new Error("This personal discount has already been used.");
}

/**
 * Count active Woo tentative holds (`_coupon_held_*` / `_maybe_used_by_*`).
 * Matches WC: only meta_keys whose embedded expiry timestamp is still in the future.
 */
export async function countActiveTentativeCouponHolds(
  couponId: number,
  aliases: string[] = [],
): Promise<{ global: number; perUser: number }> {
  const now = Math.floor(Date.now() / 1000);
  const heldPrefix = `_coupon_held_${now}`;
  const maybePrefix = `_maybe_used_by_${now}`;

  const globalRows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${t("postmeta")}
     WHERE post_id = ?
       AND meta_key LIKE '_coupon_held_%'
       AND meta_key > ?`,
    [couponId, heldPrefix],
  );
  const global = Number(globalRows[0]?.n ?? 0);

  const normalizedAliases = [
    ...new Set(
      aliases
        .map((a) => String(a ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  let perUser = 0;
  if (normalizedAliases.length) {
    const ph = normalizedAliases.map(() => "?").join(",");
    const rows = await query<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM ${t("postmeta")}
       WHERE post_id = ?
         AND meta_key LIKE '_maybe_used_by_%'
         AND meta_key > ?
         AND LOWER(meta_value) IN (${ph})`,
      [couponId, maybePrefix, ...normalizedAliases],
    );
    perUser = Number(rows[0]?.n ?? 0);
  }

  return { global, perUser };
}

export async function countUsedByForAliases(
  couponId: number,
  aliases: string[],
): Promise<number> {
  const normalizedAliases = [
    ...new Set(
      aliases
        .map((a) => String(a ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!normalizedAliases.length) return 0;
  const ph = normalizedAliases.map(() => "?").join(",");
  const rows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${t("postmeta")}
     WHERE post_id = ?
       AND meta_key IN ('_used_by', 'used_by')
       AND LOWER(meta_value) IN (${ph})`,
    [couponId, ...normalizedAliases],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Expand aliases the way Woo does for per-user limits:
 * billing email, account email, user id, and billing_email usermeta.
 */
export async function resolveUsageAliases(args: {
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<string[]> {
  const aliases = new Set<string>();
  const email = args.billingEmail?.trim().toLowerCase() || "";
  if (email) aliases.add(email);

  let customerId =
    args.customerId != null && args.customerId > 0 ? args.customerId : null;

  if (!customerId && email) {
    const byEmail = await findUserByLoginOrEmail(email);
    if (byEmail) customerId = byEmail.id;
  }

  if (customerId) {
    aliases.add(String(customerId));
    const user = await findUserById(customerId);
    if (user?.email) aliases.add(user.email.trim().toLowerCase());
    const billingMeta = await queryOne<{ meta_value: string }>(
      `SELECT meta_value FROM ${t("usermeta")}
       WHERE user_id = ? AND meta_key = 'billing_email'
       LIMIT 1`,
      [customerId],
    );
    const billingEmailMeta = billingMeta?.meta_value?.trim().toLowerCase();
    if (billingEmailMeta?.includes("@")) aliases.add(billingEmailMeta);
  }

  return [...aliases].filter(Boolean);
}

/**
 * Same rule Woo uses before attaching a coupon to an order:
 * `usage_count + active _coupon_held_* >= usage_limit` (and the per-user
 * equivalent with `_maybe_used_by_*` / `_used_by` across email + user id aliases).
 */
export async function assertCouponUsageLimitLikeWoo(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<void> {
  const codes = normalizeCodes(args.couponCodes);
  const aliases = await resolveUsageAliases(args);

  for (const code of codes) {
    const coupon = await loadCoupon(code);
    if (!coupon) continue;

    const holds = await countActiveTentativeCouponHolds(coupon.id, aliases);
    const globalLimit =
      coupon.usageLimit ?? (coupon.isPersonalIssue ? 1 : null);
    if (
      isCouponUsageLimitReached(
        coupon.usageCount,
        holds.global,
        globalLimit,
      )
    ) {
      const stuck = holds.global > 0 && coupon.usageCount < (globalLimit ?? 0);
      throw new Error(
        stuck
          ? `Coupon "${coupon.code}" cannot be applied because it is already on an incomplete checkout. Complete or cancel that order first, then try again.`
          : `Usage limit for coupon "${coupon.code}" has been reached.`,
      );
    }

    const perUserLimit =
      coupon.usageLimitPerUser ?? (coupon.isPersonalIssue ? 1 : null);
    if (perUserLimit != null) {
      const usedBy = aliases.length
        ? await countUsedByForAliases(coupon.id, aliases)
        : 0;
      // With aliases: count holds for those identities (Woo get_usage_by_user_id).
      // Without aliases on a personal issue: any active maybe_used_by blocks.
      let maybeHolds = holds.perUser;
      if (!aliases.length && coupon.isPersonalIssue) {
        const now = Math.floor(Date.now() / 1000);
        const rows = await query<{ n: number }[]>(
          `SELECT COUNT(*) AS n FROM ${t("postmeta")}
           WHERE post_id = ?
             AND meta_key LIKE '_maybe_used_by_%'
             AND meta_key > ?`,
          [coupon.id, `_maybe_used_by_${now}`],
        );
        maybeHolds = Number(rows[0]?.n ?? 0);
      }
      if (isCouponUsageLimitReached(usedBy, maybeHolds, perUserLimit)) {
        const stuck = maybeHolds > 0 && usedBy < perUserLimit;
        throw new Error(
          stuck
            ? `Coupon "${coupon.code}" cannot be applied because it is already on an incomplete checkout. Complete or cancel that order first, then try again.`
            : `Usage limit for coupon "${coupon.code}" has been reached.`,
        );
      }
    }
  }
}

/** @deprecated Prefer assertCouponUsageLimitLikeWoo */
export async function assertCouponNotTentativelyHeld(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<void> {
  return assertCouponUsageLimitLikeWoo(args);
}

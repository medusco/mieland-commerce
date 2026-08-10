import { query, t, type SqlParam } from "../db/mysql.js";

const UNPAID_STATUSES = ["pending", "failed", "on-hold"] as const;
/** Paid / finalized statuses that permanently consume a single-use coupon. */
const PAID_STATUSES = [
  "processing",
  "completed",
  "refunded",
  "partially-refunded",
] as const;

export type UnpaidCouponHold = {
  orderId: number;
  code: string;
  status: string;
};

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
  const codes = [
    ...new Set(
      args.couponCodes
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!codes.length) return [];

  const customerId =
    args.customerId != null && args.customerId > 0 ? args.customerId : null;
  const email = args.billingEmail?.trim().toLowerCase() || null;
  if (!customerId && !email) return [];

  const codePlaceholders = codes.map(() => "?").join(",");
  const statusPlaceholders = UNPAID_STATUSES.map(() => "?").join(",");
  const params: SqlParam[] = [...UNPAID_STATUSES, ...codes];

  let ownerClause = "";
  if (customerId && email) {
    ownerClause = "AND (o.customer_id = ? OR LOWER(o.billing_email) = ?)";
    params.push(customerId, email);
  } else if (customerId) {
    ownerClause = "AND o.customer_id = ?";
    params.push(customerId);
  } else {
    ownerClause = "AND LOWER(o.billing_email) = ?";
    params.push(email!);
  }

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
       ${ownerClause}
     ORDER BY o.id DESC`,
    params,
  );

  return rows.map((row) => ({
    orderId: Number(row.id),
    code: String(row.order_item_name ?? "").trim().toUpperCase(),
    status: String(row.status ?? "").replace(/^wc-/, ""),
  }));
}

/** True when any of the codes are locked to an unpaid checkout for this shopper. */
export async function isCouponHeldByUnpaidOrder(args: {
  couponCodes: string[];
  customerId?: number | null;
  billingEmail?: string | null;
}): Promise<boolean> {
  const holds = await findUnpaidOrdersHoldingCoupons(args);
  return holds.length > 0;
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
  const codes = [
    ...new Set(
      args.couponCodes
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!codes.length) return [];

  const customerId =
    args.customerId != null && args.customerId > 0 ? args.customerId : null;
  const email = args.billingEmail?.trim().toLowerCase() || null;
  if (!customerId && !email) return [];

  const codePlaceholders = codes.map(() => "?").join(",");
  const statusPlaceholders = PAID_STATUSES.map(() => "?").join(",");
  const params: SqlParam[] = [...PAID_STATUSES, ...codes];

  let ownerClause = "";
  if (customerId && email) {
    ownerClause = "AND (o.customer_id = ? OR LOWER(o.billing_email) = ?)";
    params.push(customerId, email);
  } else if (customerId) {
    ownerClause = "AND o.customer_id = ?";
    params.push(customerId);
  } else {
    ownerClause = "AND LOWER(o.billing_email) = ?";
    params.push(email!);
  }

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
       ${ownerClause}
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

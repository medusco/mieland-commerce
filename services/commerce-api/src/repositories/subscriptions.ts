import { query, queryOne, t, type SqlParam } from "../db/mysql.js";
import {
  FREQUENCIES,
  isValidFrequency,
  nextPaymentFrom,
} from "../engine/types.js";
import { getSubscriptionDiscounts } from "../engine/pricing.js";

export type SubscriptionRow = {
  id: number;
  user_id: number;
  status: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  frequency: string;
  next_payment_at: string | Date;
  parent_order_id: number;
  last_order_id: number;
  last_payment_error: string | null;
  created_at: string | Date;
  cancelled_at: string | Date | null;
};

function iso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.includes("T") ? v : `${v.replace(" ", "T")}Z`;
  return v.toISOString();
}

export function toGraphqlSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    status: row.status,
    productId: row.product_id,
    variationId: row.variation_id,
    quantity: row.quantity,
    frequency: row.frequency,
    nextPaymentAt: iso(row.next_payment_at),
    parentOrderId: row.parent_order_id,
    lastOrderId: row.last_order_id,
    lastPaymentError: row.last_payment_error,
    createdAt: iso(row.created_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

export async function getSubscriptionSettings() {
  const discounts = await getSubscriptionDiscounts();
  return {
    discounts: FREQUENCIES.map((frequency) => ({
      frequency,
      discountPercent: discounts[frequency] ?? 0,
    })),
  };
}

export async function listSubscriptions(userId: number, status?: string | null) {
  let sql = `SELECT * FROM ${t("mieland_subscriptions")} WHERE user_id = ?`;
  const params: SqlParam[] = [userId];
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY id DESC`;
  const rows = await query<SubscriptionRow[]>(sql, params);
  return rows.map(toGraphqlSubscription);
}

export async function getSubscription(id: number, userId: number) {
  const row = await queryOne<SubscriptionRow>(
    `SELECT * FROM ${t("mieland_subscriptions")} WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  return row ? toGraphqlSubscription(row) : null;
}

export async function updateSubscription(
  id: number,
  userId: number,
  input: { frequency?: string | null; quantity?: number | null },
) {
  const row = await queryOne<SubscriptionRow>(
    `SELECT * FROM ${t("mieland_subscriptions")} WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!row) throw new Error("Subscription not found.");
  if (Number(row.user_id) !== userId) {
    throw new Error("You are not allowed to edit this subscription.");
  }
  if (!["active", "payment_failed", "paused"].includes(row.status)) {
    throw new Error("Only active subscriptions can be edited.");
  }

  const updates: string[] = [];
  const params: SqlParam[] = [];

  if (input.frequency != null) {
    if (!isValidFrequency(input.frequency)) throw new Error("Invalid frequency.");
    updates.push("frequency = ?");
    params.push(input.frequency);
    // Plan: recompute next_payment_at from current schedule when frequency changes
    const base =
      typeof row.next_payment_at === "string"
        ? row.next_payment_at
        : row.next_payment_at.toISOString().slice(0, 19).replace("T", " ");
    // Re-anchor from "now" so schedule reflects new cadence
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    void base;
    updates.push("next_payment_at = ?");
    params.push(nextPaymentFrom(now, input.frequency));
  }

  if (input.quantity != null) {
    if (input.quantity < 1) throw new Error("Quantity must be at least 1.");
    updates.push("quantity = ?");
    params.push(input.quantity);
  }

  if (!updates.length) throw new Error("No changes provided.");
  updates.push("updated_at = UTC_TIMESTAMP()");
  params.push(id, userId);

  await query(
    `UPDATE ${t("mieland_subscriptions")} SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`,
    params,
  );

  return getSubscription(id, userId);
}

export async function cancelSubscription(id: number, userId: number) {
  const row = await queryOne<SubscriptionRow>(
    `SELECT * FROM ${t("mieland_subscriptions")} WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!row) throw new Error("Subscription not found.");
  if (Number(row.user_id) !== userId) {
    throw new Error("You are not allowed to cancel this subscription.");
  }
  await query(
    `UPDATE ${t("mieland_subscriptions")}
     SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return getSubscription(id, userId);
}

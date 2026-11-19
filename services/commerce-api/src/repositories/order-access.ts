import { timingSafeEqual } from "node:crypto";

/** Order meta key written by markOrderGa4Tracked for the storefront purchase event. */
export const GA4_PURCHASE_TRACKED_META = "_mieland_ga4_purchase_tracked";

export type OrderKeyAuthFailureReason =
  | "empty_key"
  | "key_mismatch"
  | "billing_email_mismatch"
  | "customer_auth_required"
  | "customer_mismatch";

export type OrderKeyAuthResult =
  | { ok: true }
  | { ok: false; reason: OrderKeyAuthFailureReason };

/**
 * Constant-time equality for order keys. Requires equal byte lengths;
 * empty or unequal-length values never match.
 */
export function orderKeysEqual(provided: string, stored: string): boolean {
  if (!provided || !stored) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Strict authorization for orderByKey (stricter than processOrderPayment):
 * non-empty key must exactly equal the stored key (no fallback to stored key),
 * optional billingEmail must match case-insensitively when provided,
 * and customer-owned orders also require a matching JWT userId.
 */
export function authorizeOrderByKey(input: {
  orderKeyProvided: string;
  orderKeyStored: string;
  billingEmailProvided?: string | null;
  billingEmailStored?: string | null;
  customerId: number;
  userId: number | null;
}): OrderKeyAuthResult {
  const provided = (input.orderKeyProvided ?? "").trim();
  if (!provided) {
    return { ok: false, reason: "empty_key" };
  }
  if (!orderKeysEqual(provided, input.orderKeyStored ?? "")) {
    return { ok: false, reason: "key_mismatch" };
  }

  const billingProvided = input.billingEmailProvided?.trim() ?? "";
  if (billingProvided) {
    const orderEmail = (input.billingEmailStored ?? "").trim().toLowerCase();
    if (orderEmail !== billingProvided.toLowerCase()) {
      return { ok: false, reason: "billing_email_mismatch" };
    }
  }

  if (input.customerId > 0) {
    if (input.userId == null) {
      return { ok: false, reason: "customer_auth_required" };
    }
    if (input.userId !== input.customerId) {
      return { ok: false, reason: "customer_mismatch" };
    }
  }

  return { ok: true };
}

/**
 * Authorization for markOrderGa4Tracked:
 * signed-in owner (JWT matches customer_id; orderKey optional),
 * or exact orderKey for guest orders (customer_id === 0).
 */
export function authorizeMarkOrderGa4Tracked(input: {
  customerId: number;
  userId: number | null;
  orderKeyProvided?: string | null;
  orderKeyStored: string;
}): OrderKeyAuthResult {
  if (input.customerId > 0) {
    if (input.userId != null && input.userId === input.customerId) {
      return { ok: true };
    }
    return { ok: false, reason: "customer_auth_required" };
  }

  const provided = (input.orderKeyProvided ?? "").trim();
  if (!provided) {
    return { ok: false, reason: "empty_key" };
  }
  if (!orderKeysEqual(provided, input.orderKeyStored ?? "")) {
    return { ok: false, reason: "key_mismatch" };
  }
  return { ok: true };
}

/** True when `_mieland_ga4_purchase_tracked` meta is non-empty. */
export function ga4PurchaseTrackedFromMeta(
  meta: Record<string, string>,
): boolean {
  return Boolean(meta[GA4_PURCHASE_TRACKED_META]?.trim());
}

/** Map INSERT affectedRows to whether markOrderGa4Tracked newly marked the order. */
export function ga4TrackedMarkWasNew(affectedRows: number): boolean {
  return affectedRows > 0;
}

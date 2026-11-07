/** Detect subscription line items from WooCommerce REST line_items (checkout / $0 paths). */
export function wcLineItemsHaveSubscription(lineItems: unknown): boolean {
  if (!Array.isArray(lineItems)) return false;
  return lineItems.some((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const lineItem = item as Record<string, unknown>;
    const lineItemMeta = Array.isArray(lineItem.meta_data)
      ? lineItem.meta_data
      : [];
    return lineItemMeta.some((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      const meta = m as { key?: string; value?: unknown };
      const key = String(meta.key ?? "");
      return (
        (key === "_subscription_frequency" || key === "subscription_frequency") &&
        typeof meta.value === "string" &&
        meta.value.trim().length > 0
      );
    });
  });
}

/** Server-authoritative $0 total (WooCommerce order total). */
export function isWcZeroOrderTotal(total: unknown): boolean {
  const n = Number(total);
  return Number.isFinite(n) && n === 0;
}

export function shouldAutoMarkZeroNonSubscriptionPaid(
  total: unknown,
  hasSubscriptions: boolean,
): boolean {
  return isWcZeroOrderTotal(total) && !hasSubscriptions;
}

export function shouldDeferZeroSubscriptionAtCheckout(
  total: unknown,
  hasSubscriptions: boolean,
): boolean {
  return isWcZeroOrderTotal(total) && hasSubscriptions;
}

export function orderMetaHasZeroOrderCompleted(
  metaData: unknown,
  key: "_mieland_zero_order_completed" | "_mieland_zero_subscription_completed",
): boolean {
  if (!Array.isArray(metaData)) return false;
  return metaData.some((m: unknown) => {
    if (!m || typeof m !== "object") return false;
    const meta = m as { key?: string };
    return meta.key === key;
  });
}

export function isOrderStatusAwaitingPayment(status: string): boolean {
  return ["pending", "on-hold", "failed"].includes(status);
}

export function isStripePmId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("pm_");
}

import { loadConfig } from "../config.js";
import { logJson } from "../utils/index.js";
import type { CalculatedCart } from "../engine/totals.js";
import type { CartAddress, CartState } from "../engine/types.js";
import { getItemFrequency } from "../engine/types.js";

export type WcOrderPayload = {
  payment_method: string;
  payment_method_title?: string;
  set_paid?: boolean;
  customer_id?: number;
  customer_note?: string;
  billing: Record<string, string>;
  shipping: Record<string, string>;
  line_items: Array<{
    product_id: number;
    variation_id?: number;
    quantity: number;
    meta_data?: Array<{ key: string; value: string }>;
  }>;
  shipping_lines?: Array<{
    method_id: string;
    method_title: string;
    total: string;
  }>;
  coupon_lines?: Array<{ code: string }>;
  meta_data?: Array<{ key: string; value: string }>;
};

function addr(a: CartAddress): Record<string, string> {
  return {
    first_name: a.firstName ?? "",
    last_name: a.lastName ?? "",
    company: a.company ?? "",
    address_1: a.address1 ?? "",
    address_2: a.address2 ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    postcode: a.postcode ?? "",
    country: a.country ?? "",
    email: a.email ?? "",
    phone: a.phone ?? "",
  };
}

export function buildWcOrderFromCart(args: {
  cart: CartState;
  calculated: CalculatedCart;
  paymentMethod: string;
  customerNote?: string | null;
  metaData?: Array<{ key: string; value: string }>;
  customerId?: number | null;
}): WcOrderPayload {
  const { cart, calculated, paymentMethod, customerNote, metaData, customerId } =
    args;

  const line_items = calculated.lines.map((line) => {
    const meta: Array<{ key: string; value: string }> = [];
    const freq = line.frequency || getItemFrequency({
      key: line.key,
      productId: line.productId,
      variationId: line.variationId,
      quantity: line.quantity,
      extraData: line.extraData,
    });
    if (freq) {
      meta.push({ key: "_subscription_frequency", value: freq });
    }
    for (const e of line.extraData) {
      if (e.key === "subscription_frequency" || e.key === "_subscription_frequency") {
        continue;
      }
      meta.push({ key: e.key, value: e.value });
    }
    return {
      product_id: line.productId,
      variation_id: line.variationId || undefined,
      quantity: line.quantity,
      meta_data: meta.length ? meta : undefined,
    };
  });

  const shipping_lines = calculated.chosenShippingMethods.map((id) => {
    const rate = calculated.availableShippingMethods
      .flatMap((p) => p.rates)
      .find((r) => r.id === id);
    return {
      method_id: rate?.methodId ?? id.split(":")[0] ?? "flat_rate",
      method_title: rate?.label ?? "Shipping",
      total: rate?.cost ?? calculated.shippingTotal,
    };
  });

  return {
    payment_method: paymentMethod || "stripe",
    payment_method_title: "Credit Card (Stripe)",
    customer_id:
      customerId !== undefined && customerId !== null
        ? customerId
        : cart.customerId || undefined,
    customer_note: customerNote || undefined,
    billing: addr(cart.billing),
    shipping: addr(cart.shipping),
    line_items,
    shipping_lines: shipping_lines.length ? shipping_lines : undefined,
    coupon_lines: cart.coupons.map((code) => ({ code })),
    meta_data: metaData,
  };
}

function wcRestOrdersUrl(orderId?: number): URL {
  const cfg = loadConfig();
  if (!cfg.WC_CONSUMER_KEY || !cfg.WC_CONSUMER_SECRET) {
    throw new Error(
      "WC REST credentials are not configured (set consumerKey/consumerSecret or WC_CONSUMER_KEY/WC_CONSUMER_SECRET)",
    );
  }
  const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
  const path =
    orderId != null
      ? `${base}/wp-json/wc/v3/orders/${orderId}`
      : `${base}/wp-json/wc/v3/orders`;
  const url = new URL(path);
  url.searchParams.set("consumer_key", cfg.WC_CONSUMER_KEY);
  url.searchParams.set("consumer_secret", cfg.WC_CONSUMER_SECRET);
  return url;
}

async function wcRestOrderRequest(
  method: "POST" | "PUT",
  url: URL,
  payload: Record<string, unknown>,
  logMsg: string,
  options?: { cookie?: string | null },
): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const started = Date.now();
  const cookie = options?.cookie?.trim() || null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.WC_REST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { message: text };
      }
      logJson("info", {
        msg: logMsg,
        status: res.status,
        ms: Date.now() - started,
        attempt,
        hasCookie: Boolean(cookie),
      });
      if (!res.ok) {
        throw new Error(
          String(body.message || body.code || `WC REST ${res.status}`),
        );
      }
      return body;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function createWcOrder(
  payload: WcOrderPayload,
  options?: { cookie?: string | null },
): Promise<Record<string, unknown>> {
  return wcRestOrderRequest(
    "POST",
    wcRestOrdersUrl(),
    payload,
    "wc_rest_create_order",
    options,
  );
}

/** Update an existing WC order (e.g. set status to failed after payment failure). */
export async function updateWcOrder(
  orderId: number,
  payload: { status?: string } & Record<string, unknown>,
  options?: { cookie?: string | null },
): Promise<Record<string, unknown>> {
  return wcRestOrderRequest(
    "PUT",
    wcRestOrdersUrl(orderId),
    payload,
    "wc_rest_update_order",
    options,
  );
}

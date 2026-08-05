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

  const gateway = paymentMethod || "stripe";
  const isPaypal =
    gateway === "ppcp-gateway" ||
    gateway === "paypal" ||
    gateway.startsWith("ppcp-");

  return {
    payment_method: gateway,
    payment_method_title: isPaypal ? "PayPal" : "Credit Card (Stripe)",
    customer_id:
      customerId !== undefined && customerId !== null
        ? customerId
        : cart.customerId || undefined,
    customer_note: customerNote || undefined,
    billing: addr(cart.billing),
    shipping: addr(cart.shipping),
    line_items,
    shipping_lines: shipping_lines.length ? shipping_lines : undefined,
    coupon_lines: calculated.appliedCoupons.map((c) => ({ code: c.code })),
    meta_data: metaData,
  };
}

function requireWcRestCredentials(): { key: string; secret: string; base: string } {
  const cfg = loadConfig();
  if (!cfg.WC_CONSUMER_KEY || !cfg.WC_CONSUMER_SECRET) {
    throw new Error(
      "WC REST credentials are not configured (set consumerKey/consumerSecret or WC_CONSUMER_KEY/WC_CONSUMER_SECRET)",
    );
  }
  return {
    key: cfg.WC_CONSUMER_KEY,
    secret: cfg.WC_CONSUMER_SECRET,
    base: cfg.WORDPRESS_URL.replace(/\/$/, ""),
  };
}

function wcRestUrl(resourcePath: string): URL {
  const { key, secret, base } = requireWcRestCredentials();
  const path = resourcePath.startsWith("/")
    ? resourcePath
    : `/${resourcePath}`;
  const url = new URL(`${base}/wp-json/wc/v3${path}`);
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  return url;
}

function wcRestOrdersUrl(orderId?: number): URL {
  return orderId != null
    ? wcRestUrl(`/orders/${orderId}`)
    : wcRestUrl("/orders");
}

async function wcRestRequest(
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
  return wcRestRequest(
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
  return wcRestRequest(
    "PUT",
    wcRestOrdersUrl(orderId),
    payload,
    "wc_rest_update_order",
    options,
  );
}

export type WcCouponCreatePayload = {
  code: string;
  discount_type: "percent" | "fixed_cart" | "fixed_product";
  amount: string;
  description?: string;
  individual_use?: boolean;
  usage_limit?: number;
  usage_limit_per_user?: number;
  email_restrictions?: string[];
  meta_data?: Array<{ key: string; value: string }>;
};

export type WcCouponResponse = {
  id: number;
  code: string;
  amount: string;
  discount_type: string;
  description?: string;
};

/** Create a WooCommerce coupon via REST `/wc/v3/coupons`. */
export async function createWcCoupon(
  payload: WcCouponCreatePayload,
): Promise<WcCouponResponse> {
  const body = await wcRestRequest(
    "POST",
    wcRestUrl("/coupons"),
    payload as unknown as Record<string, unknown>,
    "wc_rest_create_coupon",
  );
  const id = Number(body.id);
  const code = String(body.code ?? payload.code);
  if (!id || !code) {
    throw new Error("WC REST coupon create returned an invalid response");
  }
  return {
    id,
    code,
    amount: String(body.amount ?? payload.amount),
    discount_type: String(body.discount_type ?? payload.discount_type),
    description:
      typeof body.description === "string" ? body.description : payload.description,
  };
}

export type WcProductReviewCreatePayload = {
  product_id: number;
  review: string;
  reviewer: string;
  reviewer_email: string;
  rating: number;
  /** WC comment status: approved | hold | spam | trash */
  status?: "approved" | "hold" | "spam" | "trash";
};

export type WcProductReviewResponse = {
  id: number;
  product_id: number;
  status: string;
  reviewer: string;
  reviewer_email: string;
  review: string;
  rating: number;
  date_created: string | null;
};

/** Create a WooCommerce product review via REST `/wc/v3/products/reviews`. */
export async function createWcProductReview(
  payload: WcProductReviewCreatePayload,
): Promise<WcProductReviewResponse> {
  const body = await wcRestRequest(
    "POST",
    wcRestUrl("/products/reviews"),
    payload as unknown as Record<string, unknown>,
    "wc_rest_create_product_review",
  );
  const id = Number(body.id);
  if (!id) {
    throw new Error("WC REST product review create returned an invalid response");
  }
  return {
    id,
    product_id: Number(body.product_id ?? payload.product_id),
    status: String(body.status ?? payload.status ?? "hold"),
    reviewer: String(body.reviewer ?? payload.reviewer),
    reviewer_email: String(body.reviewer_email ?? payload.reviewer_email),
    review: String(body.review ?? payload.review),
    rating: Number(body.rating ?? payload.rating),
    date_created:
      typeof body.date_created === "string" ? body.date_created : null,
  };
}

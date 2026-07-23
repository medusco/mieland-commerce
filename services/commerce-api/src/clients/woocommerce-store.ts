import { loadConfig } from "../config.js";
import { logJson } from "../utils/index.js";

export type StoreAddress = {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone: string;
  /** Custom checkout address fields (Store API schema). */
  [key: string]: string | boolean | undefined;
};

export type StorePaymentDatum = { key: string; value: string | boolean };

export type StoreCheckoutOrderPayload = {
  key: string;
  billing_email?: string;
  billing_address: StoreAddress;
  shipping_address: StoreAddress;
  payment_method: string;
  payment_data?: StorePaymentDatum[];
};

export type StorePaymentResult = {
  payment_status: string;
  payment_details: Array<{ key: string; value: string }>;
  redirect_url: string;
};

export type StoreCheckoutOrderResponse = {
  order_id: number;
  status: string;
  order_key: string;
  payment_method: string;
  payment_result: StorePaymentResult;
  [key: string]: unknown;
};

function storeBase(): string {
  const cfg = loadConfig();
  return `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/wc/store/v1`;
}

function headerValue(
  headers: Headers,
  ...names: string[]
): string | null {
  for (const name of names) {
    const v = headers.get(name);
    if (v) return v;
  }
  return null;
}

export type StoreRequestAuth = {
  /** WP auth Cookie header (wordpress_logged_in_* …). */
  cookie?: string | null;
  cartToken?: string;
};

/** Obtain a Cart-Token so checkout routes accept our POST without a browser nonce. */
export async function getStoreCartToken(
  auth?: StoreRequestAuth | string | null,
): Promise<string> {
  const cfg = loadConfig();
  const cookie =
    typeof auth === "string"
      ? auth
      : auth?.cookie?.trim() || null;
  const url = `${storeBase()}/cart`;
  const started = Date.now();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(cfg.WC_REST_TIMEOUT_MS),
  });
  const token = headerValue(res.headers, "Cart-Token", "cart-token");
  logJson("info", {
    msg: "wc_store_cart_token",
    status: res.status,
    ms: Date.now() - started,
    hasToken: Boolean(token),
    hasCookie: Boolean(cookie),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WC Store cart failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!token) {
    throw new Error("WC Store cart response missing Cart-Token header");
  }
  return token;
}

function storeErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const data = body.data as
    | {
        message?: string;
        params?: string[] | Record<string, string>;
        details?: Record<string, { message?: string; code?: string }>;
      }
    | undefined;
  const base = String(
    body.message || data?.message || body.code || fallback,
  );
  const parts: string[] = [];
  if (Array.isArray(data?.params)) {
    if (data.params.length) parts.push(data.params.join(", "));
  } else if (data?.params && typeof data.params === "object") {
    for (const [key, value] of Object.entries(data.params)) {
      parts.push(`${key}: ${value}`);
    }
  }
  if (data?.details && typeof data.details === "object") {
    for (const [key, detail] of Object.entries(data.details)) {
      const msg = detail?.message || detail?.code;
      if (msg) parts.push(`${key}: ${msg}`);
    }
  }
  return parts.length ? `${base} (${parts.join("; ")})` : base;
}

export type ProcessStoreCheckoutOrderOptions = {
  cartToken?: string;
  /** WP auth Cookie header so Store API runs as the paying user. */
  cookie?: string | null;
};

/**
 * Pay an existing unpaid order via Store API:
 * POST /wc/store/v1/checkout/{ORDER_ID}
 *
 * Pass the WP auth cookie (from login vault) so registered orders are owned
 * by the same user as get_current_user_id().
 */
export async function processStoreCheckoutOrder(
  orderId: number,
  payload: StoreCheckoutOrderPayload,
  cartTokenOrOptions?: string | ProcessStoreCheckoutOrderOptions,
): Promise<StoreCheckoutOrderResponse> {
  const cfg = loadConfig();
  const options: ProcessStoreCheckoutOrderOptions =
    typeof cartTokenOrOptions === "string"
      ? { cartToken: cartTokenOrOptions }
      : (cartTokenOrOptions ?? {});
  const cookie = options.cookie?.trim() || null;
  const token =
    options.cartToken ||
    (await getStoreCartToken(cookie ? { cookie } : undefined));
  const url = `${storeBase()}/checkout/${orderId}`;
  const started = Date.now();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cart-Token": token,
  };
  if (cookie) headers.Cookie = cookie;

  // Single attempt only — retrying POST /checkout/{id} while Stripe still holds
  // the order payment lock causes "Your payment is already being processed".
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      key: payload.key,
      payment_method: payload.payment_method,
      billing_address: payload.billing_address,
      shipping_address: payload.shipping_address,
      ...(payload.billing_email ? { billing_email: payload.billing_email } : {}),
      ...(payload.payment_data?.length
        ? { payment_data: payload.payment_data }
        : {}),
    }),
    signal: AbortSignal.timeout(cfg.WC_STORE_PAYMENT_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { message: text };
  }
  logJson("info", {
    msg: "wc_store_checkout_order",
    status: res.status,
    ms: Date.now() - started,
    orderId,
    hasCookie: Boolean(cookie),
  });
  if (!res.ok) {
    throw new Error(storeErrorMessage(body, `WC Store checkout ${res.status}`));
  }
  return body as StoreCheckoutOrderResponse;
}

/** Stripe PaymentMethod / Source / Token ids (not UPE type slugs like "card"). */
function isStripePaymentObjectId(value: string): boolean {
  return /^(pm_|src_|tok_|card_)/i.test(value);
}

/**
 * Map GraphQL / WPGraphQL-style Stripe meta onto Store API payment_data keys.
 *
 * WooCommerce Store API replaces $_POST with payment_data only. Modern Stripe UPE
 * expects:
 * - payment_method: gateway id ("stripe") — used to derive UPE type ("card")
 * - wc-stripe-payment-method: PaymentMethod id (pm_…)
 * - stripe_source: same id (legacy / dual support)
 *
 * Shop clients often still send WPGraphQL-style keys where
 * wc-stripe-payment-method is the UPE type ("card") and _stripe_source_id is pm_….
 */
export function toStorePaymentData(
  entries: Array<{ key: string; value?: string | null }> | undefined,
): StorePaymentDatum[] {
  if (!entries?.length) return [];
  const out: StorePaymentDatum[] = [];
  const seen = new Set<string>();

  const push = (key: string, value: string | boolean) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, value });
  };

  let sourceId: string | undefined;
  let gatewayId: string | undefined;

  for (const entry of entries) {
    const key = entry.key;
    const raw = entry.value;
    if (!key) continue;

    // Store API / Stripe expect a real boolean for this flag.
    if (
      key === "wc-stripe-new-payment-method" &&
      (raw === "true" || raw === "false" || raw === "1" || raw === "0")
    ) {
      push(key, raw === "true" || raw === "1");
      continue;
    }

    const value = String(raw ?? "");

    // WPGraphQL / shop: pm id lives on _stripe_source_id
    if (
      key === "_stripe_source_id" ||
      key === "stripe_source_id" ||
      key === "stripe_source"
    ) {
      if (value) sourceId = value;
      continue;
    }

    if (key === "_stripe_intent_id" || key === "stripe_intent_id") {
      if (value) push("stripe_intent_id", value);
      continue;
    }

    // UPE type slug only (card, google_pay, …) — not forwarded as the pm id.
    if (
      key === "_stripe_upe_payment_type" ||
      key === "stripe_upe_payment_type" ||
      key === "upePaymentType"
    ) {
      continue;
    }

    // Modern Store API: this key must be the pm_/src_ id.
    // Older shop payloads put the UPE type ("card") here instead.
    if (key === "wc-stripe-payment-method") {
      if (value && isStripePaymentObjectId(value)) {
        sourceId = sourceId || value;
      }
      continue;
    }

    // Gateway id for UPE (must be snake_case in $_POST). Do not treat as pm id.
    if (key === "payment_method" || key === "paymentMethod") {
      if (value) gatewayId = value;
      continue;
    }

    push(key, value);
  }

  if (sourceId) {
    push("wc-stripe-payment-method", sourceId);
    push("stripe_source", sourceId);
  }

  // Store API $_POST is payment_data only; UPE reads payment_method (snake_case).
  const gateway = gatewayId || "stripe";
  push("payment_method", gateway);
  push("paymentMethod", gateway);

  return out;
}

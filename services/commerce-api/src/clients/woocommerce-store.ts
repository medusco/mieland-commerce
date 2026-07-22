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
};

export type StorePaymentDatum = { key: string; value: string };

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

/** Obtain a Cart-Token so checkout routes accept our POST without a browser nonce. */
export async function getStoreCartToken(): Promise<string> {
  const cfg = loadConfig();
  const url = `${storeBase()}/cart`;
  const started = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(cfg.WC_REST_TIMEOUT_MS),
  });
  const token = headerValue(res.headers, "Cart-Token", "cart-token");
  logJson("info", {
    msg: "wc_store_cart_token",
    status: res.status,
    ms: Date.now() - started,
    hasToken: Boolean(token),
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

/**
 * Pay an existing unpaid order via Store API:
 * POST /wc/store/v1/checkout/{ORDER_ID}
 */
export async function processStoreCheckoutOrder(
  orderId: number,
  payload: StoreCheckoutOrderPayload,
  cartToken?: string,
): Promise<StoreCheckoutOrderResponse> {
  const cfg = loadConfig();
  const token = cartToken || (await getStoreCartToken());
  const url = `${storeBase()}/checkout/${orderId}`;
  const started = Date.now();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Cart-Token": token,
        },
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
        msg: "wc_store_checkout_order",
        status: res.status,
        ms: Date.now() - started,
        attempt,
        orderId,
      });
      if (!res.ok) {
        const message = String(
          body.message ||
            (body.data as { message?: string } | undefined)?.message ||
            body.code ||
            `WC Store checkout ${res.status}`,
        );
        throw new Error(message);
      }
      return body as StoreCheckoutOrderResponse;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Map GraphQL / WPGraphQL-style Stripe meta onto Store API payment_data keys. */
export function toStorePaymentData(
  entries: Array<{ key: string; value?: string | null }> | undefined,
): StorePaymentDatum[] {
  if (!entries?.length) return [];
  const out: StorePaymentDatum[] = [];
  const seen = new Set<string>();

  const push = (key: string, value: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, value });
  };

  for (const entry of entries) {
    const key = entry.key;
    const value = String(entry.value ?? "");
    if (!key) continue;

    push(key, value);

    // WPGraphQL / WC Stripe order meta → Store API Stripe payment_data aliases
    if (key === "_stripe_source_id" || key === "stripe_source_id") {
      push("stripe_source", value);
    }
    if (key === "_stripe_intent_id" || key === "stripe_intent_id") {
      push("stripe_intent_id", value);
    }
    if (key === "wc-stripe-payment-method" || key === "payment_method") {
      push("wc-stripe-payment-method", value);
    }
  }

  return out;
}

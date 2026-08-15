import { loadConfig } from "../config.js";
import { logJson } from "../utils/index.js";

export type McfTraPackage = {
  packageNumber?: number | null;
  amazonShipmentId?: string | null;
  status?: string | null;
  carrierCode?: string | null;
  trackingNumber?: string | null;
  traNumber?: string | null;
  estimatedArrival?: string | null;
  customerTrackingLink?: string | null;
};

export type McfTraResponse = {
  orderId: number;
  sellerFulfillmentOrderId: string | null;
  sentToFba: boolean;
  available: boolean;
  traNumber: string | null;
  traNumbers: string[];
  packages: McfTraPackage[];
  source: string;
  error: string | null;
};

export type McfTraEventAddress = {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
};

export type McfTraUpdateEvent = {
  eventDate: string | null;
  eventCode: string | null;
  eventDescription: string | null;
  eventAddress: McfTraEventAddress | null;
};

export type McfTraUpdatesResponse = {
  traNumber: string;
  orderId: number | null;
  sellerFulfillmentOrderId?: string | null;
  packageNumber: number | null;
  available: boolean;
  trackingNumber: string | null;
  customerTrackingLink: string | null;
  carrierCode: string | null;
  currentStatus: string | null;
  currentStatusDescription: string | null;
  shipDate?: string | null;
  estimatedArrivalDate?: string | null;
  updates: McfTraUpdateEvent[];
  source: string;
  error: string | null;
};

function internalHeaders(): Record<string, string> {
  const cfg = loadConfig();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (cfg.MIELAND_INTERNAL_REST_SECRET) {
    headers["X-Mieland-Internal-Secret"] = cfg.MIELAND_INTERNAL_REST_SECRET;
  }
  return headers;
}

/**
 * Logged-in password change: POST /wp-json/mieland/v1/set-password
 * WordPress runs `reset_password` → `wp_set_password` (same as lost-password confirm).
 */
export async function setWpUserPassword(
  userId: number,
  password: string,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.MIELAND_INTERNAL_REST_SECRET) {
    const wpHost = new URL(cfg.WORDPRESS_URL).hostname;
    const localWp = wpHost === "localhost" || wpHost === "127.0.0.1";
    if (!localWp) {
      throw new Error(
        "MIELAND_INTERNAL_REST_SECRET is required to change passwords",
      );
    }
  }
  const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/set-password`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...internalHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ userId, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    message?: string;
  };
  if (!res.ok || payload.success === false) {
    throw new Error(
      payload.message || `WordPress set-password failed (${res.status})`,
    );
  }
}

/**
 * GET /wp-json/mieland/v1/orders/{id}/mcf-tra
 * Calls Amazon GetFulfillmentOrder through the WP MCF plugin when refresh=true.
 * refresh=false reads cached order meta only.
 */
export async function fetchOrderMcfTra(
  orderId: number,
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<McfTraResponse | null> {
  const cfg = loadConfig();
  const refresh = options.refresh !== false;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
  const url = `${base}/wp-json/mieland/v1/orders/${orderId}/mcf-tra?refresh=${refresh ? "1" : "0"}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: internalHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          msg: "mcf_tra_bridge_failed",
          orderId,
          status: res.status,
        }),
      );
      return null;
    }
    return (await res.json()) as McfTraResponse;
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "mcf_tra_bridge_error",
        orderId,
        err: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/**
 * GET /wp-json/mieland/v1/orders/{id}/mcf-tra/{traNumber}/updates
 * (or /mcf-tra/{traNumber}/updates?orderId=…)
 * Calls Amazon getPackageTrackingDetails through the WP MCF plugin when refresh=true.
 */
export async function fetchMcfTraUpdates(
  traNumber: string,
  options: {
    orderId?: number | null;
    refresh?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<McfTraUpdatesResponse | null> {
  const cfg = loadConfig();
  const refresh = options.refresh !== false;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
  const encoded = encodeURIComponent(traNumber.trim());
  const refreshQ = `refresh=${refresh ? "1" : "0"}`;

  const url =
    options.orderId != null && options.orderId > 0
      ? `${base}/wp-json/mieland/v1/orders/${options.orderId}/mcf-tra/${encoded}/updates?${refreshQ}`
      : `${base}/wp-json/mieland/v1/mcf-tra/${encoded}/updates?${refreshQ}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: internalHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 404 && res.status !== 502) {
      console.warn(
        JSON.stringify({
          msg: "mcf_tra_updates_bridge_failed",
          traNumber,
          orderId: options.orderId ?? null,
          status: res.status,
        }),
      );
      return null;
    }
    return (await res.json()) as McfTraUpdatesResponse;
  } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "mcf_tra_updates_bridge_error",
          traNumber,
          orderId: options.orderId ?? null,
          err: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

export type CartTaxItemRequest = {
  productId: number;
  quantity: number;
  variationId?: number | null;
  unitPrice?: number | null;
};

export type CartTaxAddressRequest = {
  country?: string;
  state?: string;
  postcode?: string;
  city?: string;
  address1?: string;
  address2?: string;
};

export type CartTaxShippingRequest = {
  cost?: number;
  methodId?: string;
};

export type CartTaxRequest = {
  items: CartTaxItemRequest[];
  address: CartTaxAddressRequest;
  shipping?: CartTaxShippingRequest;
  customerId?: number;
};

export type CartTaxLineResponse = {
  productId: number;
  variationId: number;
  quantity: number;
  lineTotal: string;
  lineTax: string;
  name: string;
};

export type CartTaxRateTotalResponse = {
  code: string;
  label: string;
  amount: string;
};

export type CartTaxResponse = {
  success?: boolean;
  provider?: string;
  taxTotal?: string;
  contentsTax?: string;
  shippingTax?: string;
  feeTax?: string;
  subtotal?: string;
  shippingTotal?: string;
  total?: string;
  currency?: string;
  message?: string;
  taxTotals?: CartTaxRateTotalResponse[];
  items?: CartTaxLineResponse[];
  address?: CartTaxAddressRequest;
  missing?: string[];
};

/**
 * POST /wp-json/mieland/v1/cart-tax
 * TaxCloud / SST preview via WP Simple Sales Tax (no WC order created).
 */
function cartTaxRequestSummary(body: CartTaxRequest): Record<string, unknown> {
  return {
    itemCount: body.items.length,
    productIds: body.items.map((item) => item.productId),
    variationIds: body.items.map((item) => item.variationId ?? 0),
    quantities: body.items.map((item) => item.quantity),
    unitPrices: body.items.map((item) => item.unitPrice ?? null),
    customerId: body.customerId ?? 0,
    shippingCost: body.shipping?.cost ?? null,
    shippingMethodId: body.shipping?.methodId ?? null,
    address: {
      country: body.address.country ?? "",
      state: body.address.state ?? "",
      postcode: body.address.postcode ?? "",
      city: body.address.city ?? "",
    },
  };
}

function snippet(text: string, max = 800): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export async function fetchCartTax(
  body: CartTaxRequest,
  options: { timeoutMs?: number } = {},
): Promise<CartTaxResponse | null> {
  const cfg = loadConfig();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
  const url = `${base}/wp-json/mieland/v1/cart-tax`;
  const started = Date.now();
  const request = cartTaxRequestSummary(body);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...internalHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    const contentType = res.headers.get("content-type");
    const text = await res.text();
    let parsed: CartTaxResponse | null = null;
    try {
      parsed = JSON.parse(text) as CartTaxResponse;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      logJson("warn", {
        msg: "cart_tax_bridge_failed",
        reason: "http_error",
        status: res.status,
        statusText: res.statusText,
        url,
        ms,
        timeoutMs,
        contentType,
        hasInternalSecret: Boolean(cfg.MIELAND_INTERNAL_REST_SECRET),
        wordpressHost: (() => {
          try {
            return new URL(base).host;
          } catch {
            return null;
          }
        })(),
        message: parsed?.message ?? null,
        code: (parsed as { code?: string } | null)?.code ?? null,
        provider: parsed?.provider ?? null,
        success: parsed?.success ?? null,
        missing: parsed?.missing ?? null,
        taxTotal: parsed?.taxTotal ?? null,
        bodySnippet: snippet(text),
        jsonParsed: parsed != null,
        ...request,
      });
      return {
        success: false,
        message: parsed?.message ?? `cart-tax bridge HTTP ${res.status}`,
        taxTotal: "0.00",
        contentsTax: "0.00",
        shippingTax: "0.00",
        feeTax: "0.00",
      };
    }

    if (!parsed) {
      logJson("warn", {
        msg: "cart_tax_bridge_failed",
        status: res.status,
        statusText: res.statusText,
        url,
        ms,
        timeoutMs,
        contentType,
        reason: "invalid_json",
        bodySnippet: snippet(text),
        ...request,
      });
      return {
        success: false,
        message: "cart-tax bridge returned invalid JSON",
        taxTotal: "0.00",
        contentsTax: "0.00",
        shippingTax: "0.00",
        feeTax: "0.00",
      };
    }

    if (parsed.success === false) {
      logJson("warn", {
        msg: "cart_tax_bridge_failed",
        status: res.status,
        url,
        ms,
        reason: "success_false",
        message: parsed.message ?? null,
        provider: parsed.provider ?? null,
        missing: parsed.missing ?? null,
        taxTotal: parsed.taxTotal ?? null,
        ...request,
      });
    }

    return parsed;
  } catch (error) {
    logJson("warn", {
      msg: "cart_tax_bridge_error",
      url,
      ms: Date.now() - started,
      timeoutMs,
      err: error instanceof Error ? error.message : String(error),
      errName: error instanceof Error ? error.name : null,
      cause:
        error instanceof Error && error.cause != null
          ? String(error.cause)
          : null,
      ...request,
    });
    return null;
  }
}

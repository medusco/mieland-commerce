import { loadConfig } from "../config.js";

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
export async function fetchCartTax(
  body: CartTaxRequest,
  options: { timeoutMs?: number } = {},
): Promise<CartTaxResponse | null> {
  const cfg = loadConfig();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
  const url = `${base}/wp-json/mieland/v1/cart-tax`;

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
    if (!res.ok) {
      let message: string | null = null;
      try {
        const errBody = (await res.json()) as CartTaxResponse;
        message = errBody.message ?? null;
      } catch {
        /* ignore */
      }
      console.warn(
        JSON.stringify({
          msg: "cart_tax_bridge_failed",
          status: res.status,
          message,
        }),
      );
      return {
        success: false,
        message: message ?? `cart-tax bridge HTTP ${res.status}`,
        taxTotal: "0.00",
        contentsTax: "0.00",
        shippingTax: "0.00",
        feeTax: "0.00",
      };
    }
    return (await res.json()) as CartTaxResponse;
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "cart_tax_bridge_error",
        err: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

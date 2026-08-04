import { getRedis } from "../redis/client.js";
import { logJson } from "../utils/index.js";
import {
  getPaypalMerchantCredentials,
  type PaypalMerchantCredentials,
} from "../repositories/paypal.js";

type PaypalAccessToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export type CreatePaypalOrderArgs = {
  amount: string;
  currency?: string;
  intent?: "CAPTURE" | "AUTHORIZE";
  customId?: string;
  invoiceId?: string;
  softDescriptor?: string;
};

export type PaypalOrderResult = {
  id: string;
  status: string;
};

function paypalApiBase(sandbox: boolean): string {
  return sandbox
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
}

async function getAccessToken(
  creds: PaypalMerchantCredentials,
): Promise<string> {
  const redis = getRedis();
  const cacheKey = `paypal:token:${creds.sandbox ? "sandbox" : "live"}:${creds.clientId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const basic = Buffer.from(
    `${creds.clientId}:${creds.clientSecret}`,
  ).toString("base64");
  const started = Date.now();
  const res = await fetch(`${paypalApiBase(creds.sandbox)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: PaypalAccessToken;
  try {
    body = JSON.parse(text) as PaypalAccessToken;
  } catch {
    throw new Error(`PayPal auth failed (${res.status}): ${text.slice(0, 200)}`);
  }
  logJson("info", {
    msg: "paypal_oauth",
    status: res.status,
    ms: Date.now() - started,
    sandbox: creds.sandbox,
  });
  if (!res.ok || !body.access_token) {
    throw new Error(
      `PayPal auth failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const ttl = Math.max(30, Number(body.expires_in || 300) - 60);
  await redis.set(cacheKey, body.access_token, "EX", ttl);
  return body.access_token;
}

/**
 * Create a PayPal Orders v2 order for the given amount.
 * Uses merchant credentials from WooCommerce PPCP options.
 */
export async function createPaypalOrder(
  args: CreatePaypalOrderArgs,
): Promise<PaypalOrderResult> {
  const creds = await getPaypalMerchantCredentials();
  if (!creds?.enabled) {
    throw new Error("PayPal is not configured or not enabled");
  }

  const amount = String(args.amount ?? "").trim();
  if (!amount || Number(amount) <= 0) {
    throw new Error("Invalid PayPal order amount");
  }

  const currency = (args.currency || "USD").toUpperCase();
  const intent = args.intent || "CAPTURE";
  const token = await getAccessToken(creds);

  const purchaseUnit: Record<string, unknown> = {
    amount: {
      currency_code: currency,
      value: Number(amount).toFixed(2),
    },
  };
  if (args.customId) purchaseUnit.custom_id = args.customId;
  if (args.invoiceId) purchaseUnit.invoice_id = args.invoiceId;
  if (args.softDescriptor) purchaseUnit.soft_descriptor = args.softDescriptor;

  const started = Date.now();
  const res = await fetch(
    `${paypalApiBase(creds.sandbox)}/v2/checkout/orders`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        intent,
        purchase_units: [purchaseUnit],
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await res.text();
  let body: { id?: string; status?: string; message?: string; name?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = { message: text };
  }
  logJson("info", {
    msg: "paypal_create_order",
    status: res.status,
    ms: Date.now() - started,
    sandbox: creds.sandbox,
    amount,
    currency,
  });
  if (!res.ok || !body.id) {
    const detail =
      body.message || body.name || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`PayPal create order failed: ${detail}`);
  }

  return {
    id: body.id,
    status: body.status || "CREATED",
  };
}

import { getOption } from "./options.js";

export const PPCP_GATEWAY_ID = "ppcp-gateway";

type PpcpCommonSettings = {
  use_sandbox?: boolean | string | number;
  sandbox_merchant?: boolean | string | number;
  merchant_connected?: boolean | string | number;
  merchant_id?: string;
  merchant_email?: string;
  client_id?: string;
  client_secret?: string;
  sandbox_client_id?: string;
  sandbox_client_secret?: string;
};

type PpcpLegacySettings = {
  enabled?: string;
  client_id?: string;
  client_secret?: string;
  sandbox_client_id?: string;
  sandbox_client_secret?: string;
  sandbox_on?: string;
  merchant_id?: string;
};

type PpcpGatewaySettings = {
  enabled?: string;
};

type PpcpPaymentSettings = {
  paypalEnabled?: boolean | string | number;
  paypal_enabled?: boolean | string | number;
};

export type PaypalMerchantCredentials = {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
  merchantId: string;
  enabled: boolean;
};

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return false;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Public + private PayPal credentials from WooCommerce PayPal Payments options.
 * Prefer new settings (`woocommerce-ppcp-data-common`); fall back to legacy.
 */
export async function getPaypalMerchantCredentials(): Promise<PaypalMerchantCredentials | null> {
  const [common, legacy, gateway, payment] = await Promise.all([
    getOption<PpcpCommonSettings>("woocommerce-ppcp-data-common"),
    getOption<PpcpLegacySettings>("woocommerce-ppcp-settings"),
    getOption<PpcpGatewaySettings>("woocommerce_ppcp-gateway_settings"),
    getOption<PpcpPaymentSettings>("woocommerce-ppcp-data-payment"),
  ]);

  const sandbox = common
    ? asBool(common.use_sandbox) || asBool(common.sandbox_merchant)
    : asBool(legacy?.sandbox_on);

  let clientId = "";
  let clientSecret = "";
  let merchantId = "";
  let connected = false;

  if (common && typeof common === "object") {
    clientId = asString(common.client_id);
    clientSecret = asString(common.client_secret);
    merchantId = asString(common.merchant_id);
    connected = asBool(common.merchant_connected) || Boolean(clientId && clientSecret);
  }

  if ((!clientId || !clientSecret) && legacy && typeof legacy === "object") {
    if (sandbox) {
      clientId = clientId || asString(legacy.sandbox_client_id);
      clientSecret = clientSecret || asString(legacy.sandbox_client_secret);
    } else {
      clientId = clientId || asString(legacy.client_id);
      clientSecret = clientSecret || asString(legacy.client_secret);
    }
    merchantId = merchantId || asString(legacy.merchant_id);
    connected = connected || Boolean(clientId && clientSecret);
  }

  if (!clientId || !clientSecret) {
    return null;
  }

  const gatewayEnabled =
    gateway == null ? true : asBool(gateway.enabled) || gateway.enabled === "yes";
  const paymentEnabled =
    payment == null
      ? true
      : asBool(payment.paypalEnabled) || asBool(payment.paypal_enabled);
  const legacyEnabled =
    legacy == null ? true : asBool(legacy.enabled) || legacy.enabled === "yes";

  return {
    clientId,
    clientSecret,
    sandbox,
    merchantId,
    enabled: connected && gatewayEnabled && paymentEnabled && legacyEnabled,
  };
}

/** Public shape for GraphQL — never includes client_secret. */
export async function getPaypalPublicSettings(): Promise<{
  clientId: string | null;
  sandbox: boolean;
  enabled: boolean;
  merchantId: string | null;
}> {
  const creds = await getPaypalMerchantCredentials();
  if (!creds) {
    return {
      clientId: null,
      sandbox: false,
      enabled: false,
      merchantId: null,
    };
  }
  return {
    clientId: creds.clientId,
    sandbox: creds.sandbox,
    enabled: creds.enabled,
    merchantId: creds.merchantId || null,
  };
}

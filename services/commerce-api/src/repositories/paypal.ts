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
  const [common, legacy, gateway] = await Promise.all([
    getOption<PpcpCommonSettings>("woocommerce-ppcp-data-common"),
    getOption<PpcpLegacySettings>("woocommerce-ppcp-settings"),
    getOption<PpcpGatewaySettings>("woocommerce_ppcp-gateway_settings"),
  ]);

  const sandboxFromCommon =
    common && typeof common === "object"
      ? asBool(common.use_sandbox) || asBool(common.sandbox_merchant)
      : false;
  const sandboxFromLegacy = asBool(legacy?.sandbox_on);
  const sandbox = sandboxFromCommon || sandboxFromLegacy;

  let clientId = "";
  let clientSecret = "";
  let merchantId = "";
  let connected = false;

  if (common && typeof common === "object") {
    clientId = asString(common.client_id);
    clientSecret = asString(common.client_secret);
    merchantId = asString(common.merchant_id);
    connected =
      asBool(common.merchant_connected) || Boolean(clientId && clientSecret);
  }

  // Legacy option may hold live and/or sandbox credentials.
  if (legacy && typeof legacy === "object") {
    if (!clientId || !clientSecret) {
      if (sandbox) {
        clientId =
          clientId ||
          asString(legacy.sandbox_client_id) ||
          asString(legacy.client_id);
        clientSecret =
          clientSecret ||
          asString(legacy.sandbox_client_secret) ||
          asString(legacy.client_secret);
      } else {
        clientId =
          clientId ||
          asString(legacy.client_id) ||
          asString(legacy.sandbox_client_id);
        clientSecret =
          clientSecret ||
          asString(legacy.client_secret) ||
          asString(legacy.sandbox_client_secret);
      }
    }
    merchantId = merchantId || asString(legacy.merchant_id);
    connected = connected || Boolean(clientId && clientSecret);
  }

  if (!clientId || !clientSecret) {
    return null;
  }

  // Gateway enabled flag: missing option → treat as enabled when credentials exist.
  // Do not consult woocommerce-ppcp-data-payment — that file toggles Venmo/Pay
  // Later/etc., not the main PayPal Smart Button method.
  const gatewayExplicitlyDisabled =
    gateway != null &&
    "enabled" in gateway &&
    !asBool(gateway.enabled) &&
    gateway.enabled !== "yes";

  const legacyExplicitlyDisabled =
    legacy != null &&
    "enabled" in legacy &&
    !asBool(legacy.enabled) &&
    legacy.enabled !== "yes";

  return {
    clientId,
    clientSecret,
    sandbox,
    merchantId,
    // If credentials exist and nothing explicitly disables the gateway, enable.
    enabled: connected && !gatewayExplicitlyDisabled && !legacyExplicitlyDisabled,
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

import { query, queryOne, t } from "../db/mysql.js";
import { logJson } from "../utils/index.js";
import { loadConfig } from "../config.js";

export type PaymentToken = {
  id: number;
  userId: number;
  gateway: string;
  token: string;
  isDefault: boolean;
  type: string;
  cardType?: string | null;
  last4?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
};

/**
 * List all payment tokens for a customer from woocommerce_payment_tokens table.
 */
export async function listCustomerPaymentTokens(
  userId: number,
): Promise<PaymentToken[]> {
  try {
    const rows = await query<
      {
        token_id: number;
        user_id: number;
        gateway_id: string;
        token: string;
        is_default: number;
        type: string;
      }[]
    >(
      `SELECT token_id, user_id, gateway_id, token, is_default, type
       FROM ${t("woocommerce_payment_tokens")}
       WHERE user_id = ?
       ORDER BY is_default DESC, token_id DESC`,
      [userId],
    );

    const tokens: PaymentToken[] = [];
    for (const row of rows) {
      // Load token meta for card_type, last4, expiry_month, expiry_year
      const meta = await getPaymentTokenMeta(row.token_id);
      tokens.push({
        id: row.token_id,
        userId: row.user_id,
        gateway: row.gateway_id,
        token: row.token,
        isDefault: row.is_default === 1,
        type: row.type,
        cardType: meta.card_type ?? null,
        last4: meta.last4 ?? null,
        expiryMonth: meta.expiry_month ?? null,
        expiryYear: meta.expiry_year ?? null,
      });
    }
    return tokens;
  } catch (err) {
    logJson("error", {
      msg: "list_payment_tokens_failed",
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Failed to list payment tokens");
  }
}

/**
 * Get payment token meta (card_type, last4, expiry_month, expiry_year).
 */
async function getPaymentTokenMeta(
  tokenId: number,
): Promise<Record<string, string>> {
  const rows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value
     FROM ${t("woocommerce_payment_tokenmeta")}
     WHERE payment_token_id = ?`,
    [tokenId],
  );
  const meta: Record<string, string> = {};
  for (const row of rows) {
    meta[row.meta_key] = row.meta_value;
  }
  return meta;
}

/**
 * Add payment token meta.
 */
async function setPaymentTokenMeta(
  tokenId: number,
  key: string,
  value: string,
): Promise<void> {
  await query(
    `INSERT INTO ${t("woocommerce_payment_tokenmeta")} (payment_token_id, meta_key, meta_value)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
    [tokenId, key, value],
  );
}

/**
 * Create a payment token for the customer.
 * This saves a Stripe PaymentMethod ID as a WooCommerce payment token.
 */
export async function createCustomerPaymentToken(
  userId: number,
  input: {
    gateway: string;
    token: string;
    type?: string;
    cardType?: string;
    last4?: string;
    expiryMonth?: string;
    expiryYear?: string;
  },
): Promise<PaymentToken> {
  try {
    const gateway = input.gateway || "stripe";
    const type = input.type || "CC";

    // Insert into woocommerce_payment_tokens
    const result = await query<{ insertId: number }>(
      `INSERT INTO ${t("woocommerce_payment_tokens")}
       (user_id, gateway_id, token, type, is_default)
       VALUES (?, ?, ?, ?, 0)`,
      [userId, gateway, input.token, type],
    );

    const tokenId = result.insertId;

    // Add token meta
    if (input.cardType) {
      await setPaymentTokenMeta(tokenId, "card_type", input.cardType);
    }
    if (input.last4) {
      await setPaymentTokenMeta(tokenId, "last4", input.last4);
    }
    if (input.expiryMonth) {
      await setPaymentTokenMeta(tokenId, "expiry_month", input.expiryMonth);
    }
    if (input.expiryYear) {
      await setPaymentTokenMeta(tokenId, "expiry_year", input.expiryYear);
    }

    // If this is the first token, set it as default
    const existingTokens = await listCustomerPaymentTokens(userId);
    if (existingTokens.length === 1) {
      await setCustomerDefaultPaymentToken(userId, tokenId);
    }

    return {
      id: tokenId,
      userId,
      gateway,
      token: input.token,
      isDefault: existingTokens.length === 1,
      type,
      cardType: input.cardType ?? null,
      last4: input.last4 ?? null,
      expiryMonth: input.expiryMonth ?? null,
      expiryYear: input.expiryYear ?? null,
    };
  } catch (err) {
    logJson("error", {
      msg: "create_payment_token_failed",
      userId,
      gateway: input.gateway,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Failed to create payment token");
  }
}

/**
 * Delete a payment token (must belong to the user).
 */
export async function deleteCustomerPaymentToken(
  userId: number,
  tokenId: number,
): Promise<boolean> {
  try {
    // Verify ownership
    const token = await queryOne<{ user_id: number; is_default: number }>(
      `SELECT user_id, is_default FROM ${t("woocommerce_payment_tokens")} WHERE token_id = ?`,
      [tokenId],
    );

    if (!token || token.user_id !== userId) {
      throw new Error("Payment token not found or unauthorized");
    }

    // Delete token meta
    await query(
      `DELETE FROM ${t("woocommerce_payment_tokenmeta")} WHERE payment_token_id = ?`,
      [tokenId],
    );

    // Delete token
    await query(
      `DELETE FROM ${t("woocommerce_payment_tokens")} WHERE token_id = ?`,
      [tokenId],
    );

    // If this was the default, set another token as default
    if (token.is_default === 1) {
      const remaining = await listCustomerPaymentTokens(userId);
      if (remaining.length > 0) {
        await setCustomerDefaultPaymentToken(userId, remaining[0]!.id);
      }
    }

    return true;
  } catch (err) {
    logJson("error", {
      msg: "delete_payment_token_failed",
      userId,
      tokenId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (
      err instanceof Error &&
      err.message.includes("not found or unauthorized")
    ) {
      throw err;
    }
    throw new Error("Failed to delete payment token");
  }
}

/**
 * Set the default payment token for a customer.
 */
export async function setCustomerDefaultPaymentToken(
  userId: number,
  tokenId: number,
): Promise<boolean> {
  try {
    // Verify ownership
    const token = await queryOne<{ user_id: number }>(
      `SELECT user_id FROM ${t("woocommerce_payment_tokens")} WHERE token_id = ?`,
      [tokenId],
    );

    if (!token || token.user_id !== userId) {
      throw new Error("Payment token not found or unauthorized");
    }

    // Clear existing default
    await query(
      `UPDATE ${t("woocommerce_payment_tokens")} SET is_default = 0 WHERE user_id = ?`,
      [userId],
    );

    // Set new default
    await query(
      `UPDATE ${t("woocommerce_payment_tokens")} SET is_default = 1 WHERE token_id = ?`,
      [tokenId],
    );

    return true;
  } catch (err) {
    logJson("error", {
      msg: "set_default_payment_token_failed",
      userId,
      tokenId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (
      err instanceof Error &&
      err.message.includes("not found or unauthorized")
    ) {
      throw err;
    }
    throw new Error("Failed to set default payment token");
  }
}

/**
 * Fetch Stripe PaymentMethod details to populate card metadata.
 * Returns null if the PaymentMethod cannot be retrieved.
 */
export async function fetchStripePaymentMethodDetails(
  paymentMethodId: string,
): Promise<{
  cardType?: string;
  last4?: string;
  expiryMonth?: string;
  expiryYear?: string;
} | null> {
  try {
    const cfg = loadConfig();
    if (!cfg.STRIPE_SECRET_KEY) {
      logJson("warn", {
        msg: "stripe_secret_key_missing",
        detail: "Cannot fetch PaymentMethod details without STRIPE_SECRET_KEY",
      });
      return null;
    }

    const url = `https://api.stripe.com/v1/payment_methods/${paymentMethodId}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.STRIPE_SECRET_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logJson("warn", {
        msg: "stripe_fetch_payment_method_failed",
        paymentMethodId,
        status: res.status,
      });
      return null;
    }

    const pm = (await res.json()) as {
      card?: {
        brand?: string;
        last4?: string;
        exp_month?: number;
        exp_year?: number;
      };
    };

    if (!pm.card) return null;

    return {
      cardType: pm.card.brand?.toLowerCase() ?? undefined,
      last4: pm.card.last4 ?? undefined,
      expiryMonth: pm.card.exp_month?.toString() ?? undefined,
      expiryYear: pm.card.exp_year?.toString() ?? undefined,
    };
  } catch (err) {
    logJson("warn", {
      msg: "stripe_fetch_payment_method_error",
      paymentMethodId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

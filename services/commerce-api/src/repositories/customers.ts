import { query, queryOne, t } from "../db/mysql.js";
import {
  EMAIL_VERIFIED_META,
  isEmailVerified,
  setUserMeta,
  findUserById,
  updateUserPassword,
} from "../auth/index.js";
import { getRedis } from "../redis/client.js";
import { toGlobalId } from "../utils/index.js";
import {
  addressFromCustomerMeta,
  getUserAddressMeta,
} from "../engine/shipping.js";
import type { CartAddress } from "../engine/types.js";

export async function hasGuestOrdersForEmail(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const row = await queryOne<{ found: number }>(
    `SELECT 1 AS found
     FROM ${t("wc_orders")} o
     INNER JOIN ${t("wc_order_addresses")} a
       ON a.order_id = o.id AND a.address_type = 'billing'
     WHERE o.customer_id = 0
       AND o.type = 'shop_order'
       AND LOWER(a.email) = ?
     LIMIT 1`,
    [normalized],
  );
  return Boolean(row?.found);
}

export async function getCustomer(userId: number, sessionToken?: string) {
  const user = await findUserById(userId);
  if (!user) return null;
  const meta = await getUserAddressMeta(userId);
  const emailConfirmed = await isEmailVerified(userId);
  const hasGuestOrders = await hasGuestOrdersForEmail(user.email);
  return {
    id: toGlobalId("customer", userId),
    databaseId: userId,
    email: user.email,
    firstName: user.firstName || meta.first_name || "",
    lastName: user.lastName || meta.last_name || "",
    username: user.username,
    sessionToken: sessionToken ?? null,
    emailConfirmed,
    hasGuestOrders,
    billing: addressFromCustomerMeta(meta, "billing"),
    shipping: addressFromCustomerMeta(meta, "shipping"),
  };
}

async function writeAddress(
  userId: number,
  prefix: "billing" | "shipping",
  addr: CartAddress,
  overwrite: boolean,
): Promise<void> {
  const fields: Array<[string, string | undefined]> = [
    [`${prefix}_first_name`, addr.firstName],
    [`${prefix}_last_name`, addr.lastName],
    [`${prefix}_company`, addr.company],
    [`${prefix}_address_1`, addr.address1],
    [`${prefix}_address_2`, addr.address2],
    [`${prefix}_city`, addr.city],
    [`${prefix}_state`, addr.state],
    [`${prefix}_postcode`, addr.postcode],
    [`${prefix}_country`, addr.country],
    [`${prefix}_phone`, addr.phone],
  ];
  if (prefix === "billing" && addr.email !== undefined) {
    fields.push(["billing_email", addr.email]);
  }
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    if (!overwrite && value === "") continue;
    await setUserMeta(userId, key, value ?? "");
  }
}

export async function updateCustomerProfile(
  userId: number,
  input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    billing?: CartAddress & { overwrite?: boolean };
    shipping?: CartAddress & { overwrite?: boolean };
    shippingSameAsBilling?: boolean;
  },
): Promise<void> {
  if (input.firstName !== undefined) {
    await setUserMeta(userId, "first_name", input.firstName);
  }
  if (input.lastName !== undefined) {
    await setUserMeta(userId, "last_name", input.lastName);
  }
  if (input.email) {
    const current = await findUserById(userId);
    const emailChanged =
      current && input.email.toLowerCase() !== current.email.toLowerCase();
    await query(`UPDATE ${t("users")} SET user_email = ? WHERE ID = ?`, [
      input.email,
      userId,
    ]);
    if (emailChanged) {
      await setUserMeta(userId, EMAIL_VERIFIED_META, "0");
    }
  }
  if (input.password) {
    await updateUserPassword(userId, input.password);
  }
  if (input.billing) {
    await writeAddress(
      userId,
      "billing",
      input.billing,
      input.billing.overwrite !== false,
    );
  }
  if (input.shippingSameAsBilling && input.billing) {
    const { email: _email, ...shippingAddr } = input.billing;
    await writeAddress(
      userId,
      "shipping",
      shippingAddr,
      input.billing.overwrite !== false,
    );
  } else if (input.shipping) {
    await writeAddress(
      userId,
      "shipping",
      input.shipping,
      input.shipping.overwrite !== false,
    );
  }
}

/**
 * Ask WordPress REST to send the lost-password email (retrieve_password → key + wp_mail).
 * Commerce does not mint tokens or send mail itself.
 */
export async function requestWpPasswordReset(
  username: string,
): Promise<{
  success: boolean;
  token: string | null;
  login: string | null;
  user: unknown | null;
}> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();

  try {
    const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/password-reset`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await res.json()) as {
      success?: boolean;
      message?: string;
    };

    if (!res.ok || payload.success === false) {
      throw new Error(
        payload.message || `WordPress password-reset failed (${res.status})`,
      );
    }
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "WordPress password-reset request failed",
    );
  }

  // Always success to GraphQL callers (WP also hides unknown users).
  return {
    success: true,
    token: null,
    login: null,
    user: null,
  };
}

/**
 * Apply a new password via WordPress (check_password_reset_key + reset_password).
 */
export async function confirmWpPasswordReset(input: {
  key: string;
  password: string;
  login?: string | null;
  email?: string | null;
  id?: string | number | null;
}): Promise<{ success: boolean; login: string | null }> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();

  const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/password-reset/confirm`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: input.key,
      password: input.password,
      login: input.login || undefined,
      email: input.email || undefined,
      id: input.id ?? undefined,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    login?: string;
    message?: string;
  };

  if (!res.ok || payload.success === false) {
    throw new Error(
      payload.message || `Password reset failed (${res.status})`,
    );
  }

  return {
    success: true,
    login: payload.login ?? null,
  };
}

/**
 * Ask WordPress to send the account email-verification link.
 */
export async function requestWpEmailVerification(
  userId: number,
): Promise<{ success: boolean }> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.MIELAND_INTERNAL_REST_SECRET) {
    headers["X-Mieland-Internal-Secret"] = cfg.MIELAND_INTERNAL_REST_SECRET;
  }

  const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/email-verification/send`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    message?: string;
  };

  if (!res.ok || payload.success === false) {
    throw new Error(
      payload.message || `Email verification send failed (${res.status})`,
    );
  }

  return { success: true };
}

function emailVerificationResendKey(userId: number): string {
  return `email-verification-resend:${userId}`;
}

/**
 * Re-send verification email with a per-user cooldown (see
 * EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS).
 */
export async function requestWpEmailVerificationResend(
  userId: number,
): Promise<{ success: boolean }> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();
  const cooldownSec = cfg.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS;
  const redis = getRedis();
  const key = emailVerificationResendKey(userId);

  const acquired = await redis.set(key, "1", "EX", cooldownSec, "NX");
  if (acquired !== "OK") {
    const ttl = await redis.ttl(key);
    const wait = ttl > 0 ? ttl : cooldownSec;
    throw new Error(
      `Please wait ${wait} seconds before requesting another verification email.`,
    );
  }

  try {
    return await requestWpEmailVerification(userId);
  } catch (err) {
    await redis.del(key);
    throw err;
  }
}

/**
 * Confirm email via WordPress (validates key + marks user verified).
 */
export async function confirmWpEmailVerification(input: {
  key: string;
  login?: string | null;
  email?: string | null;
  id?: string | number | null;
}): Promise<{ success: boolean; login: string | null }> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();

  const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/email-verification/confirm`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.MIELAND_INTERNAL_REST_SECRET) {
    headers["X-Mieland-Internal-Secret"] = cfg.MIELAND_INTERNAL_REST_SECRET;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      key: input.key,
      login: input.login || undefined,
      email: input.email || undefined,
      id: input.id ?? undefined,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    login?: string;
    message?: string;
  };

  if (!res.ok || payload.success === false) {
    throw new Error(
      payload.message || `Email verification failed (${res.status})`,
    );
  }

  return {
    success: true,
    login: payload.login ?? null,
  };
}

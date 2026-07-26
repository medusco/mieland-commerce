import { query, queryOne, t } from "../db/mysql.js";
import { setUserMeta, findUserById, updateUserPassword } from "../auth/index.js";
import { toGlobalId } from "../utils/index.js";
import {
  addressFromCustomerMeta,
  getUserAddressMeta,
} from "../engine/shipping.js";
import type { CartAddress } from "../engine/types.js";

export async function getCustomer(userId: number, sessionToken?: string) {
  const user = await findUserById(userId);
  if (!user) return null;
  const meta = await getUserAddressMeta(userId);
  return {
    id: toGlobalId("customer", userId),
    databaseId: userId,
    email: user.email,
    firstName: user.firstName || meta.first_name || "",
    lastName: user.lastName || meta.last_name || "",
    username: user.username,
    sessionToken: sessionToken ?? null,
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
    await query(`UPDATE ${t("users")} SET user_email = ? WHERE ID = ?`, [
      input.email,
      userId,
    ]);
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
  if (input.shipping) {
    await writeAddress(
      userId,
      "shipping",
      input.shipping,
      input.shipping.overwrite !== false,
    );
  }
}

/**
 * Ask WordPress to mint a password-reset key (no email).
 * Storefront builds/sends the branded HTML email over SMTP.
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

  const user = await queryOne<{
    ID: number;
    user_login: string;
    user_email: string;
    display_name: string;
  }>(
    `SELECT ID, user_login, user_email, display_name FROM ${t("users")}
     WHERE user_login = ? OR user_email = ? LIMIT 1`,
    [username, username],
  );
  if (!user) {
    // Do not reveal existence
    return { success: true, token: null, login: null, user: null };
  }

  let token: string | null = null;
  let login: string | null = user.user_login;

  try {
    const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/password-reset`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const internalSecret =
      process.env.MIELAND_INTERNAL_REST_SECRET?.trim() || "";
    if (internalSecret) {
      headers["x-mieland-internal-secret"] = internalSecret;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.json()) as {
      success?: boolean;
      token?: string | null;
      login?: string | null;
      email?: string | null;
      message?: string;
    };

    if (!res.ok || payload.success === false) {
      throw new Error(
        payload.message || `WordPress password-reset failed (${res.status})`,
      );
    }

    token = payload.token ?? null;
    login = payload.login ?? user.user_login;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "WordPress password-reset request failed",
    );
  }

  const names = await queryOne<{ first_name: string | null }>(
    `SELECT meta_value AS first_name FROM ${t("usermeta")}
     WHERE user_id = ? AND meta_key = 'first_name' LIMIT 1`,
    [user.ID],
  );

  return {
    success: true,
    token,
    login,
    user: {
      id: toGlobalId("user", user.ID),
      databaseId: user.ID,
      email: user.user_email,
      username: user.user_login,
      firstName: names?.first_name ?? "",
      name: user.display_name,
    },
  };
}

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

/** Delegate password reset mail to WordPress (Node does not send email). */
export async function requestWpPasswordReset(
  username: string,
): Promise<{ success: boolean; user: unknown | null }> {
  const { loadConfig } = await import("../config.js");
  const cfg = loadConfig();
  const user = await queryOne<{
    ID: number;
    user_email: string;
    display_name: string;
  }>(
    `SELECT ID, user_email, display_name FROM ${t("users")}
     WHERE user_login = ? OR user_email = ? LIMIT 1`,
    [username, username],
  );
  if (!user) {
    // Do not reveal existence
    return { success: true, user: null };
  }

  try {
    const url = `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/wp-json/mieland/v1/password-reset`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      signal: AbortSignal.timeout(10_000),
    });
    void res;
  } catch {
    // Still return success shape; WP may be unreachable in local
  }

  return {
    success: true,
    user: {
      id: toGlobalId("user", user.ID),
      email: user.user_email,
      firstName: "",
      name: user.display_name,
    },
  };
}

import { randomBytes } from "node:crypto";
import { loadConfig, t } from "../config.js";
import { createWcCoupon, type WcCouponCreatePayload } from "../clients/woocommerce-rest.js";
import { getRedis } from "../redis/client.js";
import { sha256Hex, logJson } from "../utils/index.js";
import { query, queryOne } from "../db/mysql.js";
import {
  isCouponUsageExhausted,
  parseCouponUsageCount,
  parseCouponUsageLimit,
  IS_PERSONALIZED_COUPON_META,
} from "../engine/coupon-meta.js";

/**
 * Postmeta key marking personal coupons issued by commerce-api.
 * Public (no leading `_`) so WC REST reliably persists it; we also upsert via MySQL.
 */
export const PERSONAL_COUPON_EMAIL_META = "mieland_personal_coupon_email";

const LOCK_TTL_MS = 20_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PersonalCoupon = {
  id: number;
  code: string;
  amount: string;
  discountType: string;
  description: string;
  email: string;
  created: boolean;
};

export function normalizeCouponEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidCouponEmail(email: string): string {
  const normalized = normalizeCouponEmail(email);
  if (!normalized || !EMAIL_RE.test(normalized) || normalized.length > 254) {
    throw new Error("A valid email address is required");
  }
  return normalized;
}

function generateCouponCode(prefix: string): string {
  const safePrefix =
    prefix
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "")
      .slice(0, 24) || "MIELAND";
  const suffix = randomBytes(5).toString("hex").toUpperCase();
  return `${safePrefix}-${suffix}`;
}

async function findPersonalCouponByEmail(
  email: string,
): Promise<{ id: number; code: string; description: string } | null> {
  const row = await queryOne<{
    ID: number;
    post_title: string;
    post_excerpt: string;
  }>(
    `SELECT p.ID, p.post_title, p.post_excerpt
     FROM ${t("posts")} p
     INNER JOIN ${t("postmeta")} pm
       ON pm.post_id = p.ID AND pm.meta_key = ?
     WHERE p.post_type = 'shop_coupon'
       AND p.post_status = 'publish'
       AND pm.meta_value = ?
     ORDER BY p.ID ASC
     LIMIT 1`,
    [PERSONAL_COUPON_EMAIL_META, email],
  );
  if (!row) return null;
  return {
    id: row.ID,
    code: row.post_title.trim().toUpperCase(),
    description: row.post_excerpt ?? "",
  };
}

async function loadCouponMeta(
  couponId: number,
): Promise<{
  amount: string;
  discountType: string;
  usageCount: number;
  usageLimit: number | null;
}> {
  const rows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ?`,
    [couponId],
  );
  const meta = Object.fromEntries(rows.map((r) => [r.meta_key, r.meta_value]));
  return {
    amount: String(meta.coupon_amount ?? "0"),
    discountType: String(meta.discount_type ?? "percent"),
    usageCount: parseCouponUsageCount(meta.usage_count),
    usageLimit: parseCouponUsageLimit(meta.usage_limit),
  };
}

/**
 * Personal coupons are single-use. Do not re-issue or return a spent code.
 * When usage_limit is unset, treat as limit 1 (how we create these coupons).
 */
function assertPersonalCouponUnused(meta: {
  usageCount: number;
  usageLimit: number | null;
}): void {
  const limit = meta.usageLimit ?? 1;
  if (isCouponUsageExhausted(meta.usageCount, limit)) {
    throw new Error("This personal discount has already been used.");
  }
}

async function personalCouponFromExisting(
  existing: { id: number; code: string; description: string },
  email: string,
): Promise<PersonalCoupon> {
  const meta = await loadCouponMeta(existing.id);
  assertPersonalCouponUnused(meta);
  return {
    id: existing.id,
    code: existing.code,
    amount: meta.amount,
    discountType: meta.discountType,
    description: existing.description,
    email,
    created: false,
  };
}

async function loadTemplateCouponSettings(
  templateCouponId: number,
): Promise<{ amount: string; discountType: WcCouponCreatePayload["discount_type"] }> {
  const row = await queryOne<{ ID: number }>(
    `SELECT ID FROM ${t("posts")}
     WHERE ID = ? AND post_type = 'shop_coupon' AND post_status = 'publish'
     LIMIT 1`,
    [templateCouponId],
  );
  if (!row) {
    throw new Error(`Coupon template ${templateCouponId} was not found`);
  }
  const meta = await loadCouponMeta(templateCouponId);
  const discountType = meta.discountType;
  if (
    discountType !== "percent" &&
    discountType !== "fixed_cart" &&
    discountType !== "fixed_product"
  ) {
    throw new Error(`Coupon template ${templateCouponId} has an unsupported discount type`);
  }
  return {
    amount: meta.amount,
    discountType,
  };
}

async function upsertCouponMeta(
  couponId: number,
  metaKey: string,
  value: string,
): Promise<void> {
  const existing = await queryOne<{ meta_id: number }>(
    `SELECT meta_id FROM ${t("postmeta")}
     WHERE post_id = ? AND meta_key = ?
     LIMIT 1`,
    [couponId, metaKey],
  );
  if (existing) {
    await query(
      `UPDATE ${t("postmeta")} SET meta_value = ? WHERE meta_id = ?`,
      [value, existing.meta_id],
    );
    return;
  }
  await query(
    `INSERT INTO ${t("postmeta")} (post_id, meta_key, meta_value) VALUES (?, ?, ?)`,
    [couponId, metaKey, value],
  );
}

async function upsertPersonalEmailMeta(
  couponId: number,
  email: string,
): Promise<void> {
  await upsertCouponMeta(couponId, PERSONAL_COUPON_EMAIL_META, email);
}

/**
 * Get-or-create a personal one-time WooCommerce coupon for an email.
 * Repeat requests return the same code while unused (idempotent; Redis-locked).
 * Throws if the email already has a personal coupon that was redeemed.
 */
export async function getOrCreatePersonalCoupon(
  rawEmail: string,
  options?: { templateCouponId?: number },
): Promise<PersonalCoupon> {
  const email = assertValidCouponEmail(rawEmail);
  const cfg = loadConfig();
  const emailHash = sha256Hex(email).slice(0, 32);
  const lockKey = `personal-coupon:lock:${emailHash}`;
  const redis = getRedis();
  const token = `${Date.now()}-${Math.random()}`;

  let acquired =
    (await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX")) === "OK";

  if (!acquired) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const existing = await findPersonalCouponByEmail(email);
      if (existing) {
        return personalCouponFromExisting(existing, email);
      }
      const lockHeld = await redis.get(lockKey);
      if (!lockHeld) {
        acquired =
          (await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX")) === "OK";
        if (acquired) break;
      }
    }
  }

  if (!acquired) {
    const late = await findPersonalCouponByEmail(email);
    if (late) {
      return personalCouponFromExisting(late, email);
    }
    throw new Error("Discount request is already being processed. Please wait.");
  }

  try {
    const existing = await findPersonalCouponByEmail(email);
    if (existing) {
      return personalCouponFromExisting(existing, email);
    }

    const code = generateCouponCode(cfg.PERSONAL_COUPON_CODE_PREFIX);
    const template =
      options?.templateCouponId != null
        ? await loadTemplateCouponSettings(options.templateCouponId)
        : null;
    const amount = template?.amount ?? String(cfg.PERSONAL_COUPON_AMOUNT);
    const discountType = template?.discountType ?? cfg.PERSONAL_COUPON_DISCOUNT_TYPE;
    const description = `Personal one-time discount for ${email}`;

    const created = await createWcCoupon({
      code,
      discount_type: discountType,
      amount,
      description,
      individual_use: true,
      usage_limit: 1,
      usage_limit_per_user: 1,
      email_restrictions: [email],
      meta_data: [
        { key: PERSONAL_COUPON_EMAIL_META, value: email },
        { key: IS_PERSONALIZED_COUPON_META, value: "no" },
      ],
    });

    await upsertPersonalEmailMeta(created.id, email);
    await upsertCouponMeta(created.id, IS_PERSONALIZED_COUPON_META, "no");

    logJson("info", {
      msg: "personal_coupon_created",
      couponId: created.id,
      discountType: created.discount_type,
    });

    return {
      id: created.id,
      code: (created.code || code).trim().toUpperCase(),
      amount: created.amount,
      discountType: created.discount_type,
      description: created.description ?? description,
      email,
      created: true,
    };
  } finally {
    const current = await redis.get(lockKey);
    if (current === token) {
      await redis.del(lockKey);
    }
  }
}

import { closeMysql, query, t } from "../src/db/mysql.js";

const id = Number(process.argv[2] || 3350);
const keys = [
  "usage_count",
  "usage_limit",
  "usage_limit_per_user",
  "customer_email",
];
const usageMeta = await query(
  `SELECT meta_key, meta_value FROM ${t("postmeta")}
   WHERE post_id = ? AND meta_key IN (${keys.map(() => "?").join(",")})`,
  [id, ...keys],
);
const holdKeys = await query(
  `SELECT meta_key, meta_value FROM ${t("postmeta")}
   WHERE post_id = ? AND (meta_key LIKE '_coupon_held_%' OR meta_key LIKE '_maybe_used_by_%')
   ORDER BY meta_key DESC LIMIT 10`,
  [id],
);

console.log(JSON.stringify({ couponId: id, usageMeta, holdKeys }, null, 2));
await closeMysql();

import { closeMysql, query, t } from "../src/db/mysql.js";

const oid = Number(process.argv[2] || 3438);

const order = await query(
  `SELECT id, status, billing_email, customer_id, date_created_gmt
   FROM ${t("wc_orders")} WHERE id = ?`,
  [oid],
);
const items = await query(
  `SELECT order_item_id, order_item_name, order_item_type
   FROM ${t("woocommerce_order_items")} WHERE order_id = ?`,
  [oid],
);
const ometa = await query(
  `SELECT meta_key, meta_value FROM ${t("wc_orders_meta")}
   WHERE order_id = ? ORDER BY meta_key`,
  [oid],
);
const notes = await query(
  `SELECT comment_date_gmt, comment_content FROM ${t("comments")}
   WHERE comment_post_ID = ? AND comment_type = 'order_note'
   ORDER BY comment_ID DESC LIMIT 20`,
  [oid],
);

const couponMeta = ometa.filter((r) =>
  /coupon|discount|held|maybe_used|removed/i.test(
    `${r.meta_key} ${r.meta_value}`,
  ),
);

console.log(
  JSON.stringify({ order, items, couponMeta, notes }, null, 2),
);
await closeMysql();

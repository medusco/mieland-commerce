import { query, t } from "./src/db/mysql.js";

const fields = await query(
  `SELECT ID, post_excerpt AS name, post_content FROM ${t("posts")} WHERE post_parent = 3396 ORDER BY menu_order`,
);
for (const f of fields.slice(0, 5)) {
  console.log("\n---", f.name, "id", f.ID);
  console.log(f.post_content.slice(0, 300));
}

// Check _title reference pattern like seo fields
const refs = await query(
  `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = 3394 AND meta_key LIKE '\\_%'`,
);
console.log("\n=== underscore meta on 3394:");
for (const r of refs) console.log(r.meta_key, "=>", r.meta_value);

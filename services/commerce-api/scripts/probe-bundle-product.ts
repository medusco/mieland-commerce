import { query, t } from "../src/db/mysql.js";

const bundleId = Number(process.argv[2] || 3437);

const typeRows = await query<{ slug: string }[]>(
  `SELECT terms.slug
   FROM ${t("term_relationships")} tr
   JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
   JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
   WHERE tr.object_id = ? AND tt.taxonomy = 'product_type'`,
  [bundleId],
);
console.log("product_type:", typeRows.map((r) => r.slug));

const tables = await query<{ name: string }[]>(
  `SHOW TABLES LIKE '%bundled%'`,
);
console.log("bundled tables:", tables);

try {
  const items = await query<
    { bundled_item_id: number; product_id: number; menu_order: number }[]
  >(
    `SELECT bundled_item_id, product_id, menu_order
     FROM ${t("woocommerce_bundled_items")}
     WHERE bundle_id = ?
     ORDER BY menu_order ASC`,
    [bundleId],
  );
  console.log("bundled items:", items);
  const ids = items.map((i) => i.bundled_item_id);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const meta = await query<
      { bundled_item_id: number; meta_key: string; meta_value: string }[]
    >(
      `SELECT bundled_item_id, meta_key, meta_value
       FROM ${t("woocommerce_bundled_itemmeta")}
       WHERE bundled_item_id IN (${ph})`,
      ids,
    );
    console.log("bundled item meta:", meta);
  }
} catch (e) {
  console.error("bundled items query failed:", e);
}

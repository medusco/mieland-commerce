import { query, t } from "./src/db/mysql.js";
import { getPostMeta } from "./src/repositories/products.js";
import { getPageByUri, shapePageTemplate } from "./src/repositories/content.js";
import { loadAcfGraphqlGroups, shapeAcfGroupFields } from "./src/repositories/acf-graphql.js";
import { shapeAcfField } from "./src/repositories/acf.js";

const pageId = 3394;

// 1. All meta for trace page
const allMeta = await query(
  `SELECT meta_key, LEFT(meta_value, 150) AS meta_value
   FROM ${t("postmeta")} WHERE post_id = ? ORDER BY meta_key`,
  [pageId],
);
console.log("=== post 3394 meta count:", allMeta.length);
for (const row of allMeta) console.log(row.meta_key, "=>", row.meta_value);

// 2. Search for trace field keys anywhere
const traceKeys = [
  "title",
  "batch_number_input",
  "hint_text",
  "search_button_text",
  "trace_result_title",
  "badges_title",
  "mgo_description",
];
for (const key of traceKeys) {
  const hits = await query(
    `SELECT post_id, meta_key, LEFT(meta_value, 80) AS meta_value
     FROM ${t("postmeta")} WHERE meta_key = ? AND post_id = ? LIMIT 3`,
    [key, pageId],
  );
  if (hits.length) console.log("\nFOUND", key, hits);
}

// 3. Search prefixed keys
const prefixed = await query(
  `SELECT meta_key, LEFT(meta_value, 80) AS meta_value
   FROM ${t("postmeta")}
   WHERE post_id = ? AND (
     meta_key LIKE 'trace%' OR meta_key LIKE '%trace%' OR meta_key LIKE 'field_%'
   )
   ORDER BY meta_key`,
  [pageId],
);
console.log("\n=== prefixed keys on 3394:", prefixed.length);
for (const row of prefixed) console.log(row.meta_key, "=>", row.meta_value);

// 4. ACF field group 3396 child fields
const fields = await query(
  `SELECT post_excerpt AS name, post_content FROM ${t("posts")} WHERE post_parent = 3396 ORDER BY menu_order`,
);
console.log("\n=== ACF fields in group 3396:");
for (const f of fields) {
  let key = "";
  try {
    const cfg = JSON.parse(f.post_content);
    key = cfg.key ?? "";
  } catch {}
  console.log(f.name, "acf_key:", key);
}

// 5. Shape test
const page = await getPageByUri("/trace");
const groups = await loadAcfGraphqlGroups();
const traceGroup = groups.find((g) => g.graphqlFieldName === "traceFields");
if (page && traceGroup) {
  console.log("\n=== shape test for first 3 fields");
  for (const field of traceGroup.fields.slice(0, 3)) {
    const raw = page.meta[field.name];
    const shaped = await shapeAcfField(page.meta, field.name);
    console.log(field.name, "raw:", raw ?? "(missing)", "shaped:", shaped);
  }
  const groupShaped = await shapeAcfGroupFields(page.meta, traceGroup);
  console.log("\n=== traceFields.title:", groupShaped.title);
}

import { query, t } from "./src/db/mysql.js";
import { parseMaybe } from "./src/repositories/options.js";

const group = await query(
  `SELECT ID, post_title, post_excerpt, post_content FROM ${t("posts")} WHERE ID = 3396 LIMIT 1`,
);
console.log("group:", group[0]?.post_title, group[0]?.post_excerpt);
const config = parseMaybe(group[0]?.post_content ?? "");
console.log("group config keys:", Object.keys(config));
console.log("graphql_field_name:", config.graphql_field_name);
console.log("location:", JSON.stringify(config.location));

const fields = await query(
  `SELECT post_excerpt AS name, post_content FROM ${t("posts")} WHERE post_parent = 3396 ORDER BY menu_order`,
);
for (const field of fields) {
  const cfg = parseMaybe(field.post_content ?? "");
  console.log(field.name, "type:", cfg.type, "key:", cfg.key);
}

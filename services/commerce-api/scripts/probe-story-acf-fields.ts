import { query, t } from "../src/db/mysql.js";
import { unserializeAcf } from "../src/repositories/acf.js";

function parseConfig(raw: string) {
  const parsed = unserializeAcf(raw || "");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

const group = await query<{ ID: number }[]>(
  `SELECT ID FROM ${t("posts")} WHERE post_type = 'acf-field-group' AND post_excerpt LIKE '%our-story%' OR post_title LIKE '%Our Story%' LIMIT 5`,
);

const fields = await query<
  { post_excerpt: string; post_content: string; post_parent: number; ID: number }[]
>(
  `SELECT ID, post_parent, post_excerpt, post_content
   FROM ${t("posts")}
   WHERE post_type = 'acf-field' AND post_status = 'publish'`,
);

const byParent = new Map<number, typeof fields>();
for (const row of fields) {
  const list = byParent.get(row.post_parent) ?? [];
  list.push(row);
  byParent.set(row.post_parent, list);
}

function walk(parentId: number, indent = "") {
  for (const row of byParent.get(parentId) ?? []) {
    const config = parseConfig(row.post_content);
    const line = `${indent}${row.post_excerpt} (${config.type}) gql=${config.graphql_field_name ?? row.post_excerpt} parent_layout=${config.parent_layout ?? ""}`;
    if (/our_story|intro|trust|badge|content_layout/i.test(line)) console.log(line);
    walk(row.ID, `${indent}  `);
  }
}

for (const g of group) {
  console.log(`\nGroup ${g.ID}`);
  walk(g.ID, "  ");
}

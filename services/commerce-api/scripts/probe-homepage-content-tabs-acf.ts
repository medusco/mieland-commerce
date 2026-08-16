/**
 * Full dump of homepage page_blocks flexible layouts and tab repeaters.
 */
import { query, t } from "../src/db/mysql.js";
import { unserializeAcf } from "../src/repositories/acf.js";

type FieldRow = {
  ID: number;
  post_parent: number;
  post_excerpt: string;
  post_title: string;
  post_content: string;
};

function parseConfig(raw: string): Record<string, unknown> {
  const parsed = unserializeAcf(raw || "");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

const homepageGroup = await query<{ ID: number }[]>(
  `SELECT ID FROM ${t("posts")}
   WHERE post_type = 'acf-field-group' AND post_excerpt = 'homepage-fields' LIMIT 1`,
);

if (!homepageGroup[0]) {
  console.error("homepage-fields group not found");
  process.exit(1);
}

const groupId = homepageGroup[0].ID;

const fields = await query<FieldRow[]>(
  `SELECT ID, post_parent, post_excerpt, post_title, post_content
   FROM ${t("posts")}
   WHERE post_type = 'acf-field' AND post_status = 'publish'`,
);

const byParent = new Map<number, FieldRow[]>();
for (const row of fields) {
  const list = byParent.get(row.post_parent) ?? [];
  list.push(row);
  byParent.set(row.post_parent, list);
}

function fieldLine(row: FieldRow, indent: string): string {
  const config = parseConfig(row.post_content);
  return `${indent}${row.post_excerpt} (${config.type}) gql=${config.graphql_field_name ?? row.post_excerpt} show_gql=${config.show_in_graphql} parent_layout=${config.parent_layout ?? ""}`;
}

function walk(parentId: number, indent = ""): void {
  for (const row of byParent.get(parentId) ?? []) {
    console.log(fieldLine(row, indent));
    walk(row.ID, `${indent}  `);
  }
}

const pageBlocks = (byParent.get(groupId) ?? []).find(
  (row) => row.post_excerpt === "page_blocks",
);
if (!pageBlocks) {
  console.error("page_blocks field not found");
  process.exit(1);
}

const config = parseConfig(pageBlocks.post_content);
const layoutsRaw = config.layouts;
const layouts = Array.isArray(layoutsRaw)
  ? layoutsRaw
  : layoutsRaw
    ? Object.values(layoutsRaw as Record<string, unknown>)
    : [];

console.log("page_blocks layouts:");
for (const layout of layouts) {
  const l = layout as Record<string, unknown>;
  console.log(`\n- ${l.name} key=${l.key} label=${l.label}`);
}

console.log("\nAll page_blocks child fields:");
walk(pageBlocks.ID, "  ");

console.log("\nHome meta keys (page_blocks):");
const meta = await query<{ meta_key: string }[]>(
  `SELECT DISTINCT pm.meta_key
   FROM ${t("postmeta")} pm
   INNER JOIN ${t("posts")} p ON p.ID = pm.post_id
   WHERE p.post_name = 'home' AND pm.meta_key LIKE '%page_blocks%'
   ORDER BY pm.meta_key`,
);
for (const row of meta) console.log(row.meta_key);

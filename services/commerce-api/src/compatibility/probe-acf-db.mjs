import { query, t } from "../db/mysql.js";
import { phpUnserialize } from "../repositories/options.js";

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function parseMaybe(raw) {
  if (!raw) return null;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith("a:") || raw.startsWith("O:") || raw.startsWith("s:")) {
    try {
      return phpUnserialize(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

const fieldRows = await query(
  `SELECT ID, post_parent, post_excerpt, post_content, menu_order
   FROM ${t("posts")}
   WHERE post_type = 'acf-field' AND post_status = 'publish'
   ORDER BY menu_order ASC, ID ASC`,
);

const byParent = new Map();
for (const row of fieldRows) {
  const list = byParent.get(row.post_parent) ?? [];
  list.push(row);
  byParent.set(row.post_parent, list);
}

// Find homepage field group
const groups = await query(
  `SELECT ID, post_title, post_excerpt, post_content
   FROM ${t("posts")}
   WHERE post_type = 'acf-field-group' AND post_status = 'publish'`,
);

const homepageGroup = groups.find((g) => g.post_excerpt === "homepage_fields" || /homepage/i.test(g.post_title));
if (!homepageGroup) {
  console.log("Homepage group not found");
  process.exit(1);
}

console.log(`Homepage group ID=${homepageGroup.ID} title=${homepageGroup.post_title}`);

const topFields = byParent.get(homepageGroup.ID) ?? [];
for (const field of topFields) {
  const config = asRecord(parseMaybe(field.post_content));
  const type = String(config.type ?? "");
  const name = field.post_excerpt || config.name;
  console.log(`\nField: ${name} (ID=${field.ID}, type=${type})`);
  if (type !== "flexible_content") continue;

  const children = byParent.get(field.ID) ?? [];
  console.log(`  Direct children (${children.length}):`);
  for (const child of children) {
    const c = asRecord(parseMaybe(child.post_content));
    console.log(
      `    - ${child.post_excerpt || c.name} (ID=${child.ID}, type=${c.type}, parent_layout=${c.parent_layout ?? "none"})`,
    );
    const grandchildren = byParent.get(child.ID) ?? [];
    for (const gc of grandchildren) {
      const gcConfig = asRecord(parseMaybe(gc.post_content));
      console.log(
        `        * ${gc.post_excerpt || gcConfig.name} (ID=${gc.ID}, type=${gcConfig.type}, parent_layout=${gcConfig.parent_layout ?? "none"})`,
      );
    }
  }

  const layoutsRaw = config.layouts;
  const layoutList = Array.isArray(layoutsRaw)
    ? layoutsRaw
    : layoutsRaw
      ? Object.values(asRecord(layoutsRaw))
      : [];
  console.log(`  Inline layouts (${layoutList.length}):`);
  for (const layout of layoutList) {
    const l = asRecord(layout);
    const subRaw = l.sub_fields;
    const subList = Array.isArray(subRaw) ? subRaw : subRaw ? Object.values(asRecord(subRaw)) : [];
    console.log(
      `    - ${l.name} sub_fields inline=${subList.length} keys=${subList.map((s) => asRecord(s).name).join(", ")}`,
    );
  }
}

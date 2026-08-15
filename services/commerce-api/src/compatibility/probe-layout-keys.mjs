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

const row = (await query(
  `SELECT post_content FROM ${t("posts")} WHERE ID = 2855`,
))[0];
const config = asRecord(parseMaybe(row.post_content));
const layoutsRaw = config.layouts;
const layoutList = Array.isArray(layoutsRaw)
  ? layoutsRaw
  : layoutsRaw
    ? Object.values(asRecord(layoutsRaw))
    : [];
for (const layout of layoutList) {
  const l = asRecord(layout);
  console.log(`${l.name}: key=${l.key}`);
}

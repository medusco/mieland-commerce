import { loadAcfGraphqlGroups } from "./src/repositories/acf-graphql.js";
import { getPageByUri, shapePageTemplate } from "./src/repositories/content.js";
import { query, t } from "./src/db/mysql.js";

const groups = await loadAcfGraphqlGroups();
const traceGroup = groups.find((g) => g.graphqlFieldName === "traceFields");
const titleField = traceGroup?.fields.find((f) => f.name === "title");
const traceResultTitleField = traceGroup?.fields.find(
  (f) => f.name === "trace_result_title",
);
const leptoField = traceGroup?.fields.find(
  (f) => f.name === "leptosperin_description",
);

console.log("title default:", titleField?.defaultValue);
console.log("traceResultTitle default:", traceResultTitleField?.defaultValue);
console.log("leptosperin default:", leptoField?.defaultValue);

const page = await getPageByUri("/trace");
console.log("page id:", page?.databaseId);
console.log(
  "meta keys with title:",
  Object.keys(page?.meta ?? {}).filter((k) => k.toLowerCase().includes("title")),
);

const rows = await query(
  `SELECT meta_key, LEFT(meta_value, 120) AS meta_value
   FROM ${t("postmeta")}
   WHERE post_id = ?
     AND (meta_key LIKE '%title%' OR meta_key LIKE '%trace%' OR meta_key LIKE '%leptosperin%')
   ORDER BY meta_key`,
  [page?.databaseId ?? 0],
);
console.log("postmeta sample:", rows);

const shaped = await shapePageTemplate(page);
console.log("shaped title:", shaped.traceFields?.title);
console.log("shaped traceResultTitle:", shaped.traceFields?.traceResultTitle);

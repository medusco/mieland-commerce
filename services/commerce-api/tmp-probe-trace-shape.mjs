import { query, t } from "./src/db/mysql.js";
import { getPostMeta } from "./src/repositories/products.js";
import { getPageByUri, shapePageTemplate } from "./src/repositories/content.js";
import { loadAcfGraphqlGroups } from "./src/repositories/acf-graphql.js";

const page = await getPageByUri("/trace");
if (!page) {
  console.log("page not found");
  process.exit(1);
}

const metaKeys = Object.keys(page.meta).filter((k) => !k.startsWith("_") || k.includes("trace") || k === "_wp_page_template");
console.log("meta sample:", Object.keys(page.meta).filter((k) => k.includes("title") || k.includes("trace") || k.includes("batch")).slice(0, 30));
console.log("all non-underscore keys:", Object.keys(page.meta).filter((k) => !k.startsWith("_")).slice(0, 40));

const shaped = await shapePageTemplate(page);
console.log("typename:", shaped.__typename);
console.log("traceFields:", shaped.traceFields);

const groups = await loadAcfGraphqlGroups();
const traceGroup = groups.find((g) => g.graphqlFieldName === "traceFields");
console.log("trace group types:", traceGroup?.graphqlTypes);

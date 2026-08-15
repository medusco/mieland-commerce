import { query, t } from "../db/mysql.js";
import { loadAcfGraphqlGroups, shapeAcfGroupFields } from "../repositories/acf-graphql.js";
import { getPostMeta } from "../repositories/products.js";

const groups = await loadAcfGraphqlGroups();
const homepageGroup = groups.find((g) => g.graphqlFieldName === "homepageFields");
if (!homepageGroup) throw new Error("no homepage group");

const pages = await query(
  `SELECT ID, post_name FROM ${t("posts")}
   WHERE post_type = 'page' AND post_status = 'publish' AND post_name IN ('home', 'homepage', 'front-page')
   LIMIT 5`,
);

let pageId = pages[0]?.ID;
if (!pageId) {
  const any = await query(
    `SELECT ID, post_name FROM ${t("posts")}
     WHERE post_type = 'page' AND post_status = 'publish'
     ORDER BY ID ASC LIMIT 1`,
  );
  pageId = any[0]?.ID;
  console.log("Using page:", any[0]?.post_name, pageId);
} else {
  console.log("Using page:", pages[0]?.post_name, pageId);
}

const meta = await getPostMeta(pageId);
const shaped = await shapeAcfGroupFields(meta, homepageGroup);
const blocks = shaped.pageBlocks;
console.log("block count:", Array.isArray(blocks) ? blocks.length : 0);
for (const block of Array.isArray(blocks) ? blocks : []) {
  console.log({
    fieldGroupName: block?.fieldGroupName,
    __typename: block?.__typename,
    keys: block && typeof block === "object" ? Object.keys(block) : [],
  });
}

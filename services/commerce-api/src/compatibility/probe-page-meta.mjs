import { query, t } from "../db/mysql.js";
import { getPostMeta } from "../repositories/products.js";

const meta = await getPostMeta(2886);
const keys = Object.keys(meta).filter((k) => k.includes("page_blocks"));
console.log("page_blocks keys:", keys.slice(0, 30));
for (const key of keys.filter((k) => k.includes("acf_fc_layout"))) {
  console.log(key, "=", meta[key]);
}

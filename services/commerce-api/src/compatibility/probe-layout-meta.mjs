import { getPostMeta } from "../repositories/products.js";
import { unserializeAcf } from "../repositories/acf.js";

const meta = await getPostMeta(2886);
console.log("page_blocks count:", meta.page_blocks);
console.log("layout_meta raw:", meta._page_blocks_layout_meta);
try {
  const parsed = unserializeAcf(meta._page_blocks_layout_meta ?? "");
  console.log("layout_meta parsed:", JSON.stringify(parsed, null, 2));
} catch (e) {
  console.log("parse error", e);
}

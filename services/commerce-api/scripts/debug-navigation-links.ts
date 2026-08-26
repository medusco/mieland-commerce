import { getOption, getOptionsByPrefix } from "../src/repositories/options.js";
import { shapeAcfField } from "../src/repositories/acf.js";

function optionsToMeta(options: Record<string, string>, prefix: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const key = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    meta[key] = value;
  }
  return meta;
}

const cached = await getOption("options_navigation");
const firstCachedLink =
  (cached as { topMenu?: { toplinks?: Array<{ submenuColumns?: Array<{ links?: Array<{ link?: unknown }> }> }> } })
    ?.topMenu?.toplinks?.[0]?.submenuColumns?.[0]?.links?.[0]?.link;
console.log("cached options_navigation first submenu link:", JSON.stringify(firstCachedLink));

const optionMeta = optionsToMeta(await getOptionsByPrefix("options_"), "options_");
const sampleKeys = Object.keys(optionMeta).filter((k) => /toplinks.*links.*link/.test(k));
console.log("raw meta keys matching toplinks*links*link:", sampleKeys.slice(0, 10));
for (const key of sampleKeys.slice(0, 5)) {
  console.log(`  ${key} =`, JSON.stringify(optionMeta[key]?.slice(0, 160)));
}

const badgeKeys = Object.keys(optionMeta).filter((k) => /toplinks.*links_0/.test(k));
console.log("toplinks first link row keys:", badgeKeys.slice(0, 15));

const toplinks = await shapeAcfField(optionMeta, "toplinks");
const firstRow =
  (toplinks as Array<{ submenuColumns?: Array<{ links?: Array<Record<string, unknown>> }> }>)?.[0]
    ?.submenuColumns?.[0]?.links?.[0];
console.log("built first submenu row:", JSON.stringify(firstRow));

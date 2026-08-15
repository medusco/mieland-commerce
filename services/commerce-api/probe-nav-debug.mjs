import { getOption, getOptionsByPrefix } from "./src/repositories/options.js";
import { shapeAcfField, pickMeta } from "./src/repositories/acf.js";
import { getNavigation } from "./src/repositories/content.js";

function optionsToMeta(options, prefix) {
  const meta = {};
  for (const [name, value] of Object.entries(options)) {
    const key = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    meta[key] = value;
  }
  return meta;
}

const optionMeta = optionsToMeta(await getOptionsByPrefix("options_"), "options_");

const optNav = await getOption("options_navigation");
console.log("options_navigation keys:", optNav && typeof optNav === "object" ? Object.keys(optNav) : optNav);
if (optNav && typeof optNav === "object") {
  const o = optNav;
  console.log("options_navigation topMenu:", JSON.stringify(o.topMenu ?? o.top_menu, null, 2).slice(0, 1500));
  console.log("options_navigation footer:", JSON.stringify(o.footer, null, 2).slice(0, 1500));
}

for (const prefix of ["footer_", "social_", "subscription_", "trust_", "fda_", "logo_", "promo_", "top_menu", "page_", "menu_"]) {
  const matches = Object.keys(optionMeta).filter((k) => k === prefix.replace(/_$/, "") || k.startsWith(prefix));
  if (matches.length) console.log(prefix, "->", matches.slice(0, 5), matches.length > 5 ? `(+${matches.length - 5})` : "");
}
console.log("top_menu raw:", optionMeta.top_menu?.slice?.(0, 80));
console.log("footer raw:", optionMeta.footer?.slice?.(0, 80));

const topMenu = await shapeAcfField(optionMeta, "top_menu");
const footer = await shapeAcfField(optionMeta, "footer");
const toplinks = await shapeAcfField(optionMeta, "toplinks");
const footerColumns = await shapeAcfField(optionMeta, "footer_columns");
console.log("shaped toplinks count:", Array.isArray(toplinks) ? toplinks.length : toplinks);
console.log("shaped footer_columns count:", Array.isArray(footerColumns) ? footerColumns.length : footerColumns);
console.log("first toplink:", JSON.stringify(Array.isArray(toplinks) ? toplinks[0] : null, null, 2).slice(0, 800));
console.log("shaped topMenu:", JSON.stringify(topMenu, null, 2).slice(0, 2000));
console.log("shaped footer keys:", footer && typeof footer === "object" ? Object.keys(footer) : footer);
console.log("shaped footer:", JSON.stringify(footer, null, 2).slice(0, 1000));

const nav = await getNavigation();
console.log("getNavigation toplinks:", nav.topMenu?.toplinks?.length);
console.log("getNavigation footer columns:", nav.footer?.footerColumns?.length);

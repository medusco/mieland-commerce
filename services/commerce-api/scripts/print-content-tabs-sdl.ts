import { buildAcfSchema } from "../src/schema/typeDefs/acf.js";
import { loadAcfGraphqlGroups } from "../src/repositories/acf-graphql.js";
import { listPageTemplateFiles } from "../src/repositories/content.js";

const groups = await loadAcfGraphqlGroups();
const { sdl, summary } = buildAcfSchema(groups, await listPageTemplateFiles());

for (const name of summary.emittedTypes.filter((t) => /ContentTab|TopSellersLayoutTab/i.test(t))) {
  console.log(name);
}

for (const typeName of [
  "HomepageFieldsPageBlocksContentTabsLayout",
  "HomepageFieldsPageBlocksContentTabsLayoutTabs",
  "HomepageFieldsPageBlocksTopSellersLayoutTabs",
]) {
  const match = sdl.match(new RegExp(`type ${typeName} \\{[\\s\\S]*?\\n  \\}`));
  console.log(`\n${match?.[0] ?? `${typeName}: not found`}`);
}

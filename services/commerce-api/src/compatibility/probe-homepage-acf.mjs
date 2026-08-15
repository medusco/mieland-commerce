import { loadAcfGraphqlGroups } from "../repositories/acf-graphql.js";

const groups = await loadAcfGraphqlGroups();
const homepage = groups.find((g) => g.graphqlFieldName === "homepageFields");
if (!homepage) {
  console.log("homepageFields group not found");
  process.exit(1);
}

const pageBlocks = homepage.fields.find((f) => f.graphqlName === "pageBlocks" || f.name === "page_blocks");
if (!pageBlocks) {
  console.log("pageBlocks field not found. Top fields:", homepage.fields.map((f) => `${f.name} (${f.type})`));
  process.exit(1);
}

console.log(`pageBlocks type=${pageBlocks.type} layouts=${pageBlocks.layouts.length}`);
for (const layout of pageBlocks.layouts) {
  console.log(`\nLayout: ${layout.name} graphqlName=${layout.graphqlName}`);
  console.log(`  subFields (${layout.subFields.length}):`);
  for (const sf of layout.subFields) {
    console.log(`    - ${sf.name} (${sf.type}) graphqlName=${sf.graphqlName} subFields=${sf.subFields.length}`);
    for (const nested of sf.subFields) {
      console.log(`        * ${nested.name} (${nested.type}) graphqlName=${nested.graphqlName}`);
    }
  }
}

/**
 * Validate ACF-generated SDL merges with base schema (catches Railway boot crashes).
 * Usage: npx tsx src/compatibility/validate-acf-schema.ts
 */
import { createSchema } from "graphql-yoga";
import { typeDefs } from "../schema/typeDefs/index.js";
import {
  generateAcfResolvers,
  generateAcfTypeDefs,
} from "../schema/typeDefs/acf.js";
import { mergeResolvers, resolvers } from "../schema/resolvers/index.js";
import { loadAcfGraphqlGroups } from "../repositories/acf-graphql.js";

const acfGroups = await loadAcfGraphqlGroups();
const acfTypeDefs = generateAcfTypeDefs(acfGroups);

console.log(`ACF groups: ${acfGroups.length}`);
console.log(`ACF SDL length: ${acfTypeDefs.length}`);
for (const g of acfGroups) {
  if (/thumbnail/i.test(g.graphqlFieldName) || /thumbnail/i.test(g.title)) {
    console.log(`Thumbnail group: ${g.title} -> ${g.graphqlFieldName}`);
  }
}
if (acfTypeDefs.includes("type ThumbnailFields")) {
  const start = acfTypeDefs.indexOf("type ThumbnailFields");
  console.log(acfTypeDefs.slice(start, start + 400));
}

try {
  createSchema({
    typeDefs: acfTypeDefs.trim() ? [typeDefs, acfTypeDefs] : typeDefs,
    resolvers: mergeResolvers(resolvers, generateAcfResolvers(acfGroups)),
  });
  console.log("Schema OK");
} catch (err) {
  console.error("Schema FAILED:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.message.includes("interface")) {
    const ifaceMatches = acfTypeDefs.match(/interface \w+_Layout/g) ?? [];
    console.error("Interfaces:", ifaceMatches.slice(0, 20).join(", "));
  }
  process.exit(1);
}

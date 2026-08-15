/**
 * Validate ACF-generated SDL merges with base schema (catches Railway boot crashes).
 * Usage: npx tsx src/compatibility/validate-acf-schema.ts
 */
import { createSchema } from "graphql-yoga";
import { typeDefs } from "../schema/typeDefs/index.js";
import {
  buildAcfSchema,
  generateAcfResolvers,
  logAcfSchemaBuild,
} from "../schema/typeDefs/acf.js";
import { mergeResolvers, resolvers } from "../schema/resolvers/index.js";
import { loadAcfGraphqlGroups } from "../repositories/acf-graphql.js";
import { listPageTemplateFiles } from "../repositories/content.js";

const acfGroups = await loadAcfGraphqlGroups();
const acfSchema = buildAcfSchema(acfGroups, await listPageTemplateFiles());
logAcfSchemaBuild(acfSchema.summary);

try {
  createSchema({
    typeDefs: acfSchema.sdl.trim() ? [typeDefs, acfSchema.sdl] : typeDefs,
    resolvers: mergeResolvers(resolvers, generateAcfResolvers(acfGroups)),
  });
  console.log("Schema OK");
} catch (err) {
  console.error("Schema FAILED:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.message.includes("interface")) {
    const ifaceMatches = acfSchema.sdl.match(/interface \w+_Layout/g) ?? [];
    console.error("Interfaces:", ifaceMatches.slice(0, 20).join(", "));
  }
  process.exit(1);
}

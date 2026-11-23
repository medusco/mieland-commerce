import type { GraphQLSchema } from "graphql";
import { createSchema } from "graphql-yoga";
import type { AppContext } from "../context.js";
import { logJson } from "../utils/index.js";
import {
  loadAcfGraphqlGroups,
  type AcfGraphqlGroup,
} from "../repositories/acf-graphql.js";
import { listPageTemplateFiles } from "../repositories/content.js";
import {
  buildAcfSchema,
  generateAcfResolvers,
  logAcfSchemaBuild,
} from "./typeDefs/acf.js";
import { mergeResolvers, resolvers } from "./resolvers/index.js";
import { typeDefs } from "./typeDefs/index.js";

/** Base product SDL references ThumbnailFields; stub when no ACF group emits it. */
const THUMBNAIL_FIELDS_STUB = `
  type ThumbnailFields {
    productThumbnailImage: ProductThumbnailImage
  }
`;

export type AcfSchemaRefreshResult = {
  ok: boolean;
  acfGroupCount: number;
  error?: string;
};

async function buildExecutableSchema(
  acfGroups: AcfGraphqlGroup[],
  templateFiles?: string[],
): Promise<GraphQLSchema> {
  const templates = templateFiles ?? (await listPageTemplateFiles());
  const acfSchema = buildAcfSchema(acfGroups, templates);
  logAcfSchemaBuild(acfSchema.summary);
  const needsThumbnailStub = !acfSchema.sdl.includes("type ThumbnailFields");
  const acfSdl = acfSchema.sdl.trim();
  const sdlParts = [
    typeDefs,
    ...(needsThumbnailStub ? [THUMBNAIL_FIELDS_STUB] : []),
    ...(acfSdl ? [acfSdl] : []),
  ];
  return createSchema<AppContext>({
    typeDefs: sdlParts,
    resolvers: mergeResolvers(resolvers, generateAcfResolvers(acfGroups)),
  });
}

export async function buildInitialAcfExecutableSchema(
  acfGroups?: AcfGraphqlGroup[],
  options?: { templateFiles?: string[] },
): Promise<{ schema: GraphQLSchema; acfGroups: AcfGraphqlGroup[] }> {
  const groups = acfGroups ?? (await loadAcfGraphqlGroups());
  const schema = await buildExecutableSchema(groups, options?.templateFiles);
  return { schema, acfGroups: groups };
}

export type AcfSchemaSwapTarget = {
  getSchema: () => GraphQLSchema;
  setSchema: (schema: GraphQLSchema) => void;
};

export function createAcfSchemaSwapTarget(
  initial: GraphQLSchema,
): AcfSchemaSwapTarget {
  let current = initial;
  return {
    getSchema: () => current,
    setSchema: (schema) => {
      current = schema;
    },
  };
}

let refreshChain: Promise<AcfSchemaRefreshResult> = Promise.resolve({
  ok: true,
  acfGroupCount: 0,
});

/**
 * Serialize concurrent invalidations; each completed refresh uses the latest MySQL data.
 */
export function enqueueAcfSchemaRefresh(
  swap: AcfSchemaSwapTarget,
  invalidateCache: () => Promise<void>,
): Promise<AcfSchemaRefreshResult> {
  const run = async (): Promise<AcfSchemaRefreshResult> => {
    const previous = swap.getSchema();
    try {
      await invalidateCache();
      const acfGroups = await loadAcfGraphqlGroups();
      const next = await buildExecutableSchema(acfGroups);
      swap.setSchema(next);
      logJson("info", {
        msg: "acf_schema_swapped",
        acfGroupCount: acfGroups.length,
      });
      return { ok: true, acfGroupCount: acfGroups.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      swap.setSchema(previous);
      logJson("error", {
        msg: "acf_schema_refresh_failed",
        err: message,
      });
      return { ok: false, acfGroupCount: 0, error: message };
    }
  };

  const job = refreshChain.then(run, run);
  refreshChain = job.then(
    () => ({ ok: true, acfGroupCount: 0 }),
    () => ({ ok: false, acfGroupCount: 0 }),
  );
  return job;
}
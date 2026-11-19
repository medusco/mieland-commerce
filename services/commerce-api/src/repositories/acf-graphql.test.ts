import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  leanMetaPlanForAcfGroups,
  type AcfFieldDef,
  type AcfGraphqlGroup,
} from "./acf-graphql.js";
import { metaKeysForPostNeeds } from "./content.js";
import type { PostHydrateNeeds } from "../utils/selection.js";

function field(
  partial: Partial<AcfFieldDef> & Pick<AcfFieldDef, "name" | "type" | "graphqlName">,
): AcfFieldDef {
  return {
    id: partial.id ?? 1,
    parentId: partial.parentId ?? 0,
    layouts: partial.layouts ?? [],
    subFields: partial.subFields ?? [],
    ...partial,
  };
}

function group(
  partial: Partial<AcfGraphqlGroup> &
    Pick<AcfGraphqlGroup, "graphqlFieldName" | "graphqlTypes" | "fields">,
): AcfGraphqlGroup {
  return {
    id: partial.id ?? 1,
    title: partial.title ?? partial.graphqlFieldName,
    showInGraphql: partial.showInGraphql ?? true,
    mapFromLocation: partial.mapFromLocation ?? true,
    location: partial.location ?? [],
    ...partial,
  };
}

describe("leanMetaPlanForAcfGroups + Post lean meta keys", () => {
  const seoGroup = group({
    graphqlFieldName: "seoFields",
    graphqlTypes: ["Post", "Product"],
    fields: [
      field({ name: "seo_title", type: "text", graphqlName: "seoTitle" }),
      field({ name: "seo_description", type: "textarea", graphqlName: "seoDescription" }),
    ],
  });

  const shopGroup = group({
    graphqlFieldName: "shopFields",
    graphqlTypes: ["Post", "Page"],
    fields: [
      field({
        name: "content_blocks",
        type: "flexible_content",
        graphqlName: "contentBlocks",
      }),
    ],
  });

  it("includes requested group field meta keys for Post lean load", () => {
    const plan = leanMetaPlanForAcfGroups([seoGroup, shopGroup], ["seoFields"], "Post");
    assert.deepEqual(plan.keys.sort(), ["seo_description", "seo_title"]);
    assert.equal(plan.needsFullMeta, false);

    const needs: PostHydrateNeeds = {
      excerpt: false,
      content: false,
      author: false,
      categories: false,
      tags: false,
      featuredImage: false,
      honeyGuideFeatured: false,
      honeyGuideRecommended: false,
      shopContentBlocks: false,
      acfGroupFields: ["seoFields"],
    };
    const merged = [...new Set([...metaKeysForPostNeeds(needs), ...plan.keys])].sort();
    assert.deepEqual(merged, ["seo_description", "seo_title"]);
  });

  it("does not add ACF keys when no group is requested (plain post list)", () => {
    const plan = leanMetaPlanForAcfGroups([seoGroup], [], "Post");
    assert.deepEqual(plan.keys, []);
    assert.equal(plan.needsFullMeta, false);

    const needs: PostHydrateNeeds = {
      excerpt: true,
      content: false,
      author: false,
      categories: false,
      tags: false,
      featuredImage: true,
      honeyGuideFeatured: false,
      honeyGuideRecommended: false,
      shopContentBlocks: false,
      acfGroupFields: [],
    };
    assert.deepEqual(metaKeysForPostNeeds(needs).sort(), ["_thumbnail_id"]);
  });

  it("flags full meta for flexible_content groups", () => {
    const plan = leanMetaPlanForAcfGroups([shopGroup], ["shopFields"], "Post");
    assert.ok(plan.keys.includes("content_blocks"));
    assert.equal(plan.needsFullMeta, true);
  });
});

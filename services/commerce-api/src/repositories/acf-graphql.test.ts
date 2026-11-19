import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  leanMetaPlanForAcfGroups,
  locationToGraphqlTypes,
  type AcfFieldDef,
  type AcfGraphqlGroup,
  type AcfLocationRule,
} from "./acf-graphql.js";
import { metaKeysForPostNeeds } from "./content.js";
import type { PostHydrateNeeds } from "../utils/selection.js";

function rule(
  param: string,
  value: string,
  operator = "==",
): AcfLocationRule {
  return { param, operator, value };
}

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

describe("locationToGraphqlTypes", () => {
  it("maps page location rule to Page", () => {
    const types = locationToGraphqlTypes([[rule("page", "42")]]);
    assert.deepEqual(types, ["Page"]);
  });

  it("maps page_type and page_parent to Page", () => {
    assert.ok(locationToGraphqlTypes([[rule("page_type", "front_page")]]).includes("Page"));
    assert.ok(locationToGraphqlTypes([[rule("page_parent", "10")]]).includes("Page"));
  });

  it("keeps Post when post_type=post applies alongside a page rule", () => {
    const types = locationToGraphqlTypes([
      [rule("page", "42")],
      [rule("post_type", "post")],
    ]);
    assert.ok(types.includes("Page"));
    assert.ok(types.includes("Post"));
  });

  it("maps page_template to Template_* without adding Page", () => {
    const types = locationToGraphqlTypes([
      [rule("page_template", "templates/shop.php")],
    ]);
    assert.ok(types.some((t) => t.startsWith("Template_")));
    assert.ok(!types.includes("Page"));
  });

  it("still maps post_type=page to Page", () => {
    assert.deepEqual(locationToGraphqlTypes([[rule("post_type", "page")]]), ["Page"]);
  });
});

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

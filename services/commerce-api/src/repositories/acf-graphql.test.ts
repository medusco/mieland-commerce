import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parse,
  validate,
  type GraphQLSchema,
} from "graphql";
import { createSchema } from "graphql-yoga";

import {
  leanMetaPlanForAcfGroups,
  locationToGraphqlTypes,
  type AcfFieldDef,
  type AcfGraphqlGroup,
  type AcfLocationRule,
} from "./acf-graphql.js";
import { metaKeysForPostNeeds } from "./content.js";
import type { PostHydrateNeeds } from "../utils/selection.js";
import { buildAcfSchema } from "../schema/typeDefs/acf.js";
import { typeDefs } from "../schema/typeDefs/index.js";

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

/** Shop Fields ACF group as used by storefront mieland-us PR #103. */
function shopFieldsFixtureFromLocation(): AcfGraphqlGroup {
  const location = [
    [rule("page", "42")],
    [rule("post_type", "post")],
  ];
  const mapped = locationToGraphqlTypes(location);
  return group({
    id: 9001,
    title: "Shop Fields",
    graphqlFieldName: "shopFields",
    mapFromLocation: true,
    location,
    graphqlTypes: mapped,
    fields: [
      field({
        id: 9002,
        name: "content_blocks",
        type: "flexible_content",
        graphqlName: "contentBlocks",
        layouts: [
          {
            name: "honey_guide_block",
            graphqlName: "honeyGuideBlock",
            subFields: [
              field({
                name: "above_title_text",
                type: "text",
                graphqlName: "aboveTitleText",
              }),
              field({ name: "title", type: "text", graphqlName: "title" }),
              field({
                name: "subtitle",
                type: "textarea",
                graphqlName: "subtitle",
              }),
              field({
                name: "tiles",
                type: "repeater",
                graphqlName: "tiles",
                subFields: [
                  field({
                    name: "badge_title",
                    type: "text",
                    graphqlName: "badgeTitle",
                  }),
                  field({
                    name: "badge_subtitle",
                    type: "text",
                    graphqlName: "badgeSubtitle",
                  }),
                ],
              }),
              field({
                name: "promo_card",
                type: "group",
                graphqlName: "promoCard",
                subFields: [
                  field({ name: "title", type: "text", graphqlName: "title" }),
                  field({
                    name: "subtitle",
                    type: "textarea",
                    graphqlName: "subtitle",
                  }),
                  field({
                    name: "bottom_text",
                    type: "text",
                    graphqlName: "bottomText",
                  }),
                  // text: storefront treats svgIcon as SVG markup or URL string
                  field({
                    name: "svg_icon",
                    type: "text",
                    graphqlName: "svgIcon",
                  }),
                ],
              }),
            ],
          },
          {
            name: "quiz_block",
            graphqlName: "quizBlock",
            subFields: [
              field({ name: "title", type: "text", graphqlName: "title" }),
              field({
                name: "subtitle",
                type: "textarea",
                graphqlName: "subtitle",
              }),
              field({
                name: "cta_button",
                type: "link",
                graphqlName: "ctaButton",
              }),
            ],
          },
        ],
      }),
    ],
  });
}

/** Exact storefront selection from medusco/mieland-us PR #103 (inline form). */
const STOREFRONT_SHOP_PAGE_QUERY = `
  query GetShopPageFields {
    page(id: "/shop") {
      shopFields {
        contentBlocks {
          __typename
          ... on ShopFieldsContentBlocksHoneyGuideBlockLayout {
            aboveTitleText
            title
            subtitle
            tiles {
              badgeTitle
              badgeSubtitle
            }
            promoCard {
              title
              subtitle
              bottomText
              svgIcon
            }
          }
          ... on ShopFieldsContentBlocksQuizBlockLayout {
            title
            subtitle
            ctaButton {
              title
              url
            }
          }
        }
      }
    }
  }
`;

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

describe("Shop Fields page schema (storefront query)", () => {
  it("exposes Page.shopFields and validates mieland-us shop page selection", () => {
    const shopGroup = shopFieldsFixtureFromLocation();
    assert.ok(
      shopGroup.graphqlTypes.includes("Page"),
      "page location rule must map Shop Fields onto Page",
    );
    assert.ok(
      shopGroup.graphqlTypes.includes("Post"),
      "post_type=post rule must keep Post.shopFields",
    );

    const { sdl } = buildAcfSchema([shopGroup]);

    assert.match(sdl, /extend type Page \{[\s\S]*shopFields: ShopFields/);
    assert.match(sdl, /extend type Post \{[\s\S]*shopFields: ShopFields/);

    const expectedLayouts = [
      "ShopFieldsContentBlocksHoneyGuideBlockLayout",
      "ShopFieldsContentBlocksQuizBlockLayout",
    ] as const;
    for (const layout of expectedLayouts) {
      assert.match(
        sdl,
        new RegExp(`type ${layout}\\b`),
        `expected exact layout type ${layout}`,
      );
    }

    assert.match(
      sdl,
      /type ShopFieldsContentBlocksHoneyGuideBlockLayout[\s\S]*aboveTitleText: String/,
    );
    assert.match(
      sdl,
      /type ShopFieldsContentBlocksHoneyGuideBlockLayout[\s\S]*tiles: \[ShopFieldsContentBlocksHoneyGuideBlockLayoutTiles\]/,
    );
    assert.match(
      sdl,
      /type ShopFieldsContentBlocksHoneyGuideBlockLayout[\s\S]*promoCard: ShopFieldsContentBlocksHoneyGuideBlockLayoutPromoCard/,
    );
    assert.match(
      sdl,
      /type ShopFieldsContentBlocksHoneyGuideBlockLayoutPromoCard[\s\S]*svgIcon: String/,
    );
    assert.match(
      sdl,
      /type ShopFieldsContentBlocksQuizBlockLayout[\s\S]*ctaButton: AcfLink/,
    );

    // Base Product SDL references ThumbnailFields, which ACF normally emits.
    const thumbnailStub = `
  type ThumbnailFields {
    productThumbnailImage: ProductThumbnailImage
  }
`;
    const schema: GraphQLSchema = createSchema({
      typeDefs: [typeDefs, thumbnailStub, sdl],
    });
    const document = parse(STOREFRONT_SHOP_PAGE_QUERY);
    const errors = validate(schema, document);
    assert.deepEqual(
      errors.map((e) => e.message),
      [],
      "storefront shopFields query must validate against generated schema",
    );
  });
});

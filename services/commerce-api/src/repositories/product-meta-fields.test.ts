import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shapeAcfGroupFields, type AcfGraphqlGroup } from "./acf-graphql.js";
import {
  parseFlavoursAvailable,
  parseProductBadge,
  resolveProductMetaFieldExtras,
} from "./product-meta-fields.js";
import { buildAcfSchema } from "../schema/typeDefs/acf.js";

describe("parseProductBadge", () => {
  it("reads product_badge and ignores underscore ACF refs", () => {
    assert.equal(
      parseProductBadge({
        product_badge: "Best Seller",
        _product_badge: "field_abc",
      }),
      "Best Seller",
    );
  });

  it("returns null when missing or blank", () => {
    assert.equal(parseProductBadge({}), null);
    assert.equal(parseProductBadge({ product_badge: "" }), null);
    assert.equal(parseProductBadge({ product_badge: "   " }), null);
    assert.equal(parseProductBadge({ _product_badge: "field_abc" }), null);
  });
});

describe("parseFlavoursAvailable", () => {
  it("reads plain text flavours_available", () => {
    assert.equal(
      parseFlavoursAvailable({
        flavours_available: "Lemon, Ginger",
        _flavours_available: "field_xyz",
      }),
      "Lemon, Ginger",
    );
  });

  it("joins PHP-serialized lists", () => {
    assert.equal(
      parseFlavoursAvailable({
        flavours_available: 'a:2:{i:0;s:5:"Lemon";i:1;s:6:"Ginger";}',
      }),
      "Lemon, Ginger",
    );
  });

  it("returns null when missing, blank, or empty list", () => {
    assert.equal(parseFlavoursAvailable({}), null);
    assert.equal(parseFlavoursAvailable({ flavours_available: "" }), null);
    assert.equal(parseFlavoursAvailable({ flavours_available: "a:0:{}" }), null);
    assert.equal(
      parseFlavoursAvailable({ _flavours_available: "field_xyz" }),
      null,
    );
  });
});

describe("resolveProductMetaFieldExtras", () => {
  it("returns both fields from a meta bag", () => {
    assert.deepEqual(
      resolveProductMetaFieldExtras({
        product_badge: "Trending",
        flavours_available: "Manuka",
        jar_size_images: "1",
        _product_badge: "field_1",
        _flavours_available: "field_2",
      }),
      {
        productBadge: "Trending",
        flavoursAvailable: "Manuka",
      },
    );
  });
});

describe("shapeAcfGroupFields productMetaFields extras", () => {
  const group: AcfGraphqlGroup = {
    id: 1,
    title: "Product Meta",
    showInGraphql: true,
    graphqlFieldName: "productMetaFields",
    graphqlTypes: ["Product", "SimpleProduct", "VariableProduct"],
    mapFromLocation: false,
    location: [],
    fields: [
      {
        id: 2,
        name: "jar_size_images",
        type: "repeater",
        graphqlName: "jarSizeImages",
        parentId: 1,
        layouts: [],
        subFields: [],
      },
    ],
  };

  it("injects productBadge and flavoursAvailable alongside jarSizeImages", async () => {
    const shaped = await shapeAcfGroupFields(
      {
        product_badge: "Best Seller",
        flavours_available: "Lemon",
        jar_size_images: "0",
        _product_badge: "field_badge",
        _flavours_available: "field_flavours",
      },
      group,
    );
    assert.equal(shaped.productBadge, "Best Seller");
    assert.equal(shaped.flavoursAvailable, "Lemon");
    assert.ok("jarSizeImages" in shaped);
  });

  it("nulls missing extras without erroring", async () => {
    const shaped = await shapeAcfGroupFields({}, group);
    assert.equal(shaped.productBadge, null);
    assert.equal(shaped.flavoursAvailable, null);
  });
});

describe("buildAcfSchema ProductMetaFields extras", () => {
  it("always exposes productBadge and flavoursAvailable on ProductMetaFields", () => {
    const group: AcfGraphqlGroup = {
      id: 1,
      title: "Product Meta",
      showInGraphql: true,
      graphqlFieldName: "productMetaFields",
      graphqlTypes: ["Product"],
      mapFromLocation: false,
      location: [],
      fields: [
        {
          id: 2,
          name: "jar_size_images",
          type: "repeater",
          graphqlName: "jarSizeImages",
          parentId: 1,
          layouts: [],
          subFields: [],
        },
      ],
    };
    const { sdl } = buildAcfSchema([group]);
    assert.match(sdl, /type ProductMetaFields \{[\s\S]*productBadge: String/);
    assert.match(sdl, /type ProductMetaFields \{[\s\S]*flavoursAvailable: String/);
    assert.match(sdl, /jarSizeImages:/);
  });
});

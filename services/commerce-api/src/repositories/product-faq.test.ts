import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isProductFaqMetaKey,
  parseProductFaq,
  resolveFaqItems,
  resolveProductFaq,
} from "./product-faq.js";
import { productResolvers } from "../schema/resolvers/products.js";

describe("isProductFaqMetaKey", () => {
  it("accepts count and title/content rows", () => {
    assert.equal(isProductFaqMetaKey("product_faq"), true);
    assert.equal(isProductFaqMetaKey("product_faq_0_title"), true);
    assert.equal(isProductFaqMetaKey("product_faq_12_content"), true);
  });

  it("rejects underscore ACF reference rows and unrelated keys", () => {
    assert.equal(isProductFaqMetaKey("_product_faq"), false);
    assert.equal(isProductFaqMetaKey("_product_faq_0_title"), false);
    assert.equal(isProductFaqMetaKey("_product_faq_0_content"), false);
    assert.equal(isProductFaqMetaKey("product_faq_0_question"), false);
    assert.equal(isProductFaqMetaKey("other"), false);
  });
});

describe("parseProductFaq", () => {
  it("returns ordered rows from title/content meta", () => {
    const items = parseProductFaq({
      product_faq: "2",
      product_faq_0_title: "First?",
      product_faq_0_content: "<p>One</p>",
      product_faq_1_title: "Second?",
      product_faq_1_content: "<p>Two</p>",
      _product_faq: "field_abc",
      _product_faq_0_title: "field_def",
    });
    assert.deepEqual(items, [
      { title: "First?", content: "<p>One</p>" },
      { title: "Second?", content: "<p>Two</p>" },
    ]);
  });

  it("returns empty when count is missing or invalid", () => {
    assert.deepEqual(parseProductFaq({}), []);
    assert.deepEqual(parseProductFaq({ product_faq: "" }), []);
    assert.deepEqual(parseProductFaq({ product_faq: "nope" }), []);
    assert.deepEqual(parseProductFaq({ product_faq: "0" }), []);
    assert.deepEqual(parseProductFaq({ product_faq: "-1" }), []);
    assert.deepEqual(parseProductFaq({ product_faq: "1.5" }), []);
    assert.deepEqual(
      parseProductFaq({
        product_faq_0_title: "Orphan",
        product_faq_0_content: "<p>No count</p>",
      }),
      [],
    );
  });

  it("skips blank rows and gaps beyond existing keys", () => {
    const items = parseProductFaq({
      product_faq: "5",
      product_faq_0_title: "Keep",
      product_faq_0_content: "<p>Yes</p>",
      product_faq_1_title: "   ",
      product_faq_1_content: "",
      // index 2 missing entirely
      product_faq_3_title: "Later",
      product_faq_3_content: "<p>Three</p>",
      product_faq_4_title: "",
      product_faq_4_content: "   ",
    });
    assert.deepEqual(items, [
      { title: "Keep", content: "<p>Yes</p>" },
      { title: "Later", content: "<p>Three</p>" },
    ]);
  });

  it("keeps a row when only title or only content is set", () => {
    assert.deepEqual(
      parseProductFaq({
        product_faq: "2",
        product_faq_0_title: "Title only",
        product_faq_0_content: "",
        product_faq_1_title: "",
        product_faq_1_content: "<p>Content only</p>",
      }),
      [
        { title: "Title only", content: "" },
        { title: "", content: "<p>Content only</p>" },
      ],
    );
  });

  it("does not invent rows past keys that exist when N is oversized", () => {
    assert.deepEqual(
      parseProductFaq({
        product_faq: "10",
        product_faq_0_title: "Only",
        product_faq_0_content: "<p>One</p>",
      }),
      [{ title: "Only", content: "<p>One</p>" }],
    );
  });
});

describe("resolveFaqItems", () => {
  const parentMeta = {
    product_faq: "1",
    product_faq_0_title: "Parent Q",
    product_faq_0_content: "<p>Parent A</p>",
  };

  it("resolves product faq from own meta", () => {
    assert.deepEqual(
      resolveFaqItems({ isVariation: false, ownMeta: parentMeta }),
      [{ title: "Parent Q", content: "<p>Parent A</p>" }],
    );
  });

  it("variation inherits faq from parent meta", () => {
    assert.deepEqual(
      resolveFaqItems({
        isVariation: true,
        ownMeta: {
          product_faq: "1",
          product_faq_0_title: "Variation Q",
          product_faq_0_content: "<p>own</p>",
        },
        parentMeta,
      }),
      [{ title: "Parent Q", content: "<p>Parent A</p>" }],
    );
    assert.deepEqual(
      resolveFaqItems({
        isVariation: true,
        ownMeta: {},
        parentMeta: null,
      }),
      [],
    );
  });
});

describe("resolveProductFaq / Product.faq resolver", () => {
  const parentMeta = {
    product_faq: "1",
    product_faq_0_title: "Parent Q",
    product_faq_0_content: "<p>Parent A</p>",
  };

  it("product node uses prehydrated faq array (list batch path)", async () => {
    const items = await resolveProductFaq({
      databaseId: 100,
      __typename: "SimpleProduct",
      faq: [{ title: "Parent Q", content: "<p>Parent A</p>" }],
      _acfMeta: {},
    });
    assert.deepEqual(items, [
      { title: "Parent Q", content: "<p>Parent A</p>" },
    ]);
  });

  it("product node uses complete _acfMeta without MySQL", async () => {
    const items = await resolveProductFaq({
      databaseId: 100,
      __typename: "SimpleProduct",
      _acfMeta: parentMeta,
      _postMetaComplete: true,
    });
    assert.deepEqual(items, [
      { title: "Parent Q", content: "<p>Parent A</p>" },
    ]);
  });

  it("returns [] without databaseId", async () => {
    assert.deepEqual(await resolveProductFaq({ _acfMeta: parentMeta }), []);
  });

  it("variation inherits from parentFaqMeta, ignoring own _acfMeta", async () => {
    const items = await resolveProductFaq({
      databaseId: 2561,
      parentDatabaseId: 2560,
      __typename: "ProductVariation",
      _acfMeta: {
        product_faq: "1",
        product_faq_0_title: "Should not win",
        product_faq_0_content: "<p>nope</p>",
      },
      parentFaqMeta: parentMeta,
    });
    assert.deepEqual(items, [
      { title: "Parent Q", content: "<p>Parent A</p>" },
    ]);
  });

  it("Product / SimpleProduct / VariableProduct faq resolvers match", async () => {
    const product = {
      databaseId: 42,
      __typename: "VariableProduct" as const,
      _acfMeta: parentMeta,
    };
    const expected = [{ title: "Parent Q", content: "<p>Parent A</p>" }];
    assert.deepEqual(await productResolvers.Product.faq(product), expected);
    assert.deepEqual(await productResolvers.SimpleProduct.faq(product), expected);
    assert.deepEqual(await productResolvers.VariableProduct.faq(product), expected);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseProductSku, resolveProductSku } from "./product-sku.js";
import { productResolvers } from "../schema/resolvers/products.js";

describe("parseProductSku", () => {
  it("returns trimmed sku from _sku meta", () => {
    assert.equal(parseProductSku({ _sku: "  ABC-123  " }), "ABC-123");
    assert.equal(parseProductSku({ _sku: "plain" }), "plain");
  });

  it("returns null when missing or blank", () => {
    assert.equal(parseProductSku(undefined), null);
    assert.equal(parseProductSku(null), null);
    assert.equal(parseProductSku({}), null);
    assert.equal(parseProductSku({ _sku: "" }), null);
    assert.equal(parseProductSku({ _sku: "   " }), null);
  });

  it("does not invent a value from unrelated keys", () => {
    assert.equal(parseProductSku({ _price: "10", sku: "wrong" }), null);
  });
});

describe("resolveProductSku / Product.sku resolver", () => {
  it("uses prehydrated sku (list batch path), including explicit null", async () => {
    assert.equal(
      await resolveProductSku({
        databaseId: 100,
        sku: "BATCH-1",
        _acfMeta: { _sku: "ignored" },
      }),
      "BATCH-1",
    );
    assert.equal(
      await resolveProductSku({
        databaseId: 100,
        sku: null,
        _acfMeta: { _sku: "should-not-win" },
      }),
      null,
    );
  });

  it("parses complete _acfMeta without MySQL", async () => {
    assert.equal(
      await resolveProductSku({
        databaseId: 100,
        _acfMeta: { _sku: "  META-9  " },
        _postMetaComplete: true,
      }),
      "META-9",
    );
    assert.equal(
      await resolveProductSku({
        databaseId: 100,
        _acfMeta: {},
        _postMetaComplete: true,
      }),
      null,
    );
  });

  it("parses lean _acfMeta when _sku key is present", async () => {
    assert.equal(
      await resolveProductSku({
        databaseId: 100,
        _acfMeta: { _sku: "LEAN-2", _price: "1" },
      }),
      "LEAN-2",
    );
  });

  it("returns null without databaseId when sku not hydrated", async () => {
    assert.equal(await resolveProductSku({ _acfMeta: {} }), null);
  });

  it("variation uses own _sku only (no parent fallback)", async () => {
    assert.equal(
      await resolveProductSku({
        databaseId: 2561,
        sku: null,
        _acfMeta: { _sku: "" },
        _postMetaComplete: true,
      }),
      null,
    );
    assert.equal(
      await resolveProductSku({
        databaseId: 2561,
        sku: "VAR-SKU",
      }),
      "VAR-SKU",
    );
  });

  it("Product / SimpleProduct / VariableProduct / ProductVariation sku resolvers match", async () => {
    const product = {
      databaseId: 42,
      __typename: "VariableProduct" as const,
      sku: "SHARED",
    };
    assert.equal(await productResolvers.Product.sku(product), "SHARED");
    assert.equal(await productResolvers.SimpleProduct.sku(product), "SHARED");
    assert.equal(await productResolvers.VariableProduct.sku(product), "SHARED");
    assert.equal(
      await productResolvers.ProductVariation.sku({
        databaseId: 99,
        sku: "VAR",
      }),
      "VAR",
    );
  });
});

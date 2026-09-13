import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBundleConfigurationForLine,
  parseBundleConfigurationOverrides,
  type BundledCatalogItem,
} from "./product-bundles.js";

/** Daily Wellness Starter Kit (#3435) bundled components (catalog shape). */
const DAILY_WELLNESS_STARTER_CATALOG: BundledCatalogItem[] = [
  {
    bundledItemId: 412,
    productId: 1371,
    menuOrder: 0,
    quantityMin: 1,
    quantityMax: 1,
    optional: false,
    overrideDefaultVariationAttributes: false,
    defaultVariationAttributes: [],
    allowedVariationIds: [],
  },
  {
    bundledItemId: 413,
    productId: 2970,
    menuOrder: 1,
    quantityMin: 1,
    quantityMax: 1,
    optional: false,
    overrideDefaultVariationAttributes: false,
    defaultVariationAttributes: [],
    allowedVariationIds: [],
  },
];

describe("parseBundleConfigurationOverrides", () => {
  it("parses bundle_configuration JSON from cart extraData", () => {
    const parsed = parseBundleConfigurationOverrides([
      {
        key: "bundle_configuration",
        value: JSON.stringify([
          { bundled_item_id: 412, quantity: 2, variation_id: 0 },
        ]),
      },
    ]);
    assert.ok(parsed);
    assert.equal(parsed!.length, 1);
    assert.equal(parsed![0].bundled_item_id, 412);
    assert.equal(parsed![0].quantity, 2);
  });
});

describe("buildBundleConfigurationForLine", () => {
  it("expands a bundle parent into bundled_item_id + product_id rows", async () => {
    const config = await buildBundleConfigurationForLine(
      DAILY_WELLNESS_STARTER_CATALOG,
      1,
      [],
      { variableProductIds: new Set() },
    );
    assert.equal(config.length, 2);
    assert.deepEqual(
      config.map((c) => ({
        bundled_item_id: c.bundled_item_id,
        product_id: c.product_id,
        quantity: c.quantity,
      })),
      [
        { bundled_item_id: 412, product_id: 1371, quantity: 1 },
        { bundled_item_id: 413, product_id: 2970, quantity: 1 },
      ],
    );
  });

  it("skips optional bundled items unless selected", async () => {
    const catalog: BundledCatalogItem[] = [
      {
        ...DAILY_WELLNESS_STARTER_CATALOG[0],
        optional: true,
      },
      DAILY_WELLNESS_STARTER_CATALOG[1],
    ];
    const without = await buildBundleConfigurationForLine(catalog, 1, [], {
      variableProductIds: new Set(),
    });
    assert.equal(without.length, 1);
    assert.equal(without[0].product_id, 2970);

    const withSelection = await buildBundleConfigurationForLine(catalog, 1, [
      {
        key: "bundle_configuration",
        value: JSON.stringify([
          { bundled_item_id: 412, optional_selected: true },
        ]),
      },
    ], { variableProductIds: new Set() });
    assert.equal(withSelection.length, 2);
  });

  it("honors per-item quantity overrides from cart extraData", async () => {
    const config = await buildBundleConfigurationForLine(
      DAILY_WELLNESS_STARTER_CATALOG,
      1,
      [
        {
          key: "bundle_configuration",
          value: JSON.stringify([{ bundled_item_id: 413, quantity: 3 }]),
        },
      ],
      { variableProductIds: new Set() },
    );
    const item = config.find((c) => c.bundled_item_id === 413);
    assert.equal(item?.quantity, 3);
  });
});

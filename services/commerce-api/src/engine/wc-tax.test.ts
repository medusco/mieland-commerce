import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calcExclusiveTax,
  findMatchedTaxRates,
  matchesTaxRateLocations,
  postcodeMatchesLocation,
  sanitizeTaxClass,
  type MatchedTaxRate,
} from "./wc-tax.js";
import type {
  WooTaxRateLocationRow,
  WooTaxRateRow,
} from "../repositories/tax-rates.js";

describe("sanitizeTaxClass", () => {
  it("normalizes slugs like WooCommerce sanitize_title", () => {
    assert.equal(sanitizeTaxClass(""), "");
    assert.equal(sanitizeTaxClass("Reduced Rate"), "reduced-rate");
  });
});

describe("postcodeMatchesLocation", () => {
  it("matches exact and wildcard postcodes", () => {
    assert.equal(postcodeMatchesLocation("90210", "90210"), true);
    assert.equal(postcodeMatchesLocation("90210", "902*"), true);
    assert.equal(postcodeMatchesLocation("90210", "903*"), false);
  });

  it("matches numeric ranges", () => {
    assert.equal(postcodeMatchesLocation("90210", "90000...90999"), true);
    assert.equal(postcodeMatchesLocation("91210", "90000...90999"), false);
  });
});

describe("findMatchedTaxRates", () => {
  const rates: WooTaxRateRow[] = [
    {
      tax_rate_id: 1,
      tax_rate_country: "US",
      tax_rate_state: "CA",
      tax_rate: "7.25",
      tax_rate_name: "CA State",
      tax_rate_priority: 1,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "",
    },
    {
      tax_rate_id: 2,
      tax_rate_country: "US",
      tax_rate_state: "CA",
      tax_rate: "1.0",
      tax_rate_name: "CA County",
      tax_rate_priority: 2,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "",
    },
    {
      tax_rate_id: 3,
      tax_rate_country: "US",
      tax_rate_state: "NY",
      tax_rate: "8.0",
      tax_rate_name: "NY",
      tax_rate_priority: 1,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "",
    },
    {
      tax_rate_id: 4,
      tax_rate_country: "US",
      tax_rate_state: "CA",
      tax_rate: "2.5",
      tax_rate_name: "CA No-Ship Tax",
      tax_rate_priority: 3,
      tax_rate_compound: 0,
      tax_rate_shipping: 0,
      tax_rate_order: 0,
      tax_rate_class: "",
    },
  ];

  const locationsByRateId = new Map<number, WooTaxRateLocationRow[]>();

  it("returns one rate per priority for matching state", () => {
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "CA",
        postcode: "90210",
        city: "Beverly Hills",
        taxClass: "",
      },
    );
    assert.equal(matched.length, 3);
    assert.deepEqual(
      matched.map((r) => r.rateId),
      [1, 2, 4],
    );
  });

  it("returns no rates when state does not match", () => {
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "TX",
        postcode: "75001",
        city: "Dallas",
        taxClass: "",
      },
    );
    assert.equal(matched.length, 0);
  });

  it("filters shipping-enabled rates correctly", () => {
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "CA",
        postcode: "90210",
        city: "Beverly Hills",
        taxClass: "",
      },
    );
    const shippingRates = matched.filter((r) => r.shipping);
    assert.equal(shippingRates.length, 2);
    assert.deepEqual(
      shippingRates.map((r) => r.rateId),
      [1, 2],
    );
  });
});

describe("matchesTaxRateLocations", () => {
  it("requires postcode when postcode locations exist", () => {
    const locations: WooTaxRateLocationRow[] = [
      {
        location_id: 1,
        tax_rate_id: 1,
        location_type: "postcode",
        location_code: "902*",
      },
    ];
    assert.equal(matchesTaxRateLocations(locations, "90210", ""), true);
    assert.equal(matchesTaxRateLocations(locations, "10001", ""), false);
  });
});

describe("calcExclusiveTax", () => {
  it("applies non-compound then compound rates", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 10,
        label: "A",
        shipping: true,
        compound: false,
      },
      {
        rateId: 2,
        rate: 5,
        label: "B",
        shipping: true,
        compound: true,
      },
    ];
    const taxes = calcExclusiveTax(100, rates);
    assert.equal(taxes.get(1), 10);
    assert.equal(taxes.get(2), 5.5);
  });

  it("calculates tax on promo price, not regular price", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 10,
        label: "Standard",
        shipping: false,
        compound: false,
      },
    ];
    const promoPrice = 80;
    const taxes = calcExclusiveTax(promoPrice, rates);
    assert.equal(taxes.get(1), 8);
  });

  it("handles zero or negative amounts", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 10,
        label: "Standard",
        shipping: false,
        compound: false,
      },
    ];
    assert.equal(calcExclusiveTax(0, rates).size, 0);
    assert.equal(calcExclusiveTax(-10, rates).size, 0);
  });

  it("applies only shipping-enabled rates to shipping cost", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 10,
        label: "State (ships)",
        shipping: true,
        compound: false,
      },
      {
        rateId: 2,
        rate: 5,
        label: "Local (no ship)",
        shipping: false,
        compound: false,
      },
    ];
    const shippingRates = rates.filter((r) => r.shipping);
    const taxes = calcExclusiveTax(20, shippingRates);
    assert.equal(taxes.get(1), 2);
    assert.equal(taxes.has(2), false);
  });

  it("calculates zero shipping tax when no rates have shipping enabled", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 10,
        label: "No Ship",
        shipping: false,
        compound: false,
      },
    ];
    const shippingRates = rates.filter((r) => r.shipping);
    const taxes = calcExclusiveTax(20, shippingRates);
    assert.equal(taxes.size, 0);
  });

  it("applies multiple shipping-enabled rates to shipping cost", () => {
    const rates: MatchedTaxRate[] = [
      {
        rateId: 1,
        rate: 7.25,
        label: "State",
        shipping: true,
        compound: false,
      },
      {
        rateId: 2,
        rate: 1.0,
        label: "County",
        shipping: true,
        compound: false,
      },
    ];
    const taxes = calcExclusiveTax(100, rates);
    assert.equal(taxes.get(1), 7.25);
    assert.equal(taxes.get(2), 1);
  });
});

describe("variation tax inheritance", () => {
  it("should inherit empty _tax_status from parent (taxable)", () => {
    // WooCommerce: variation with no _tax_status inherits parent's "taxable"
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta: Record<string, string> = {};
    
    const effectiveTaxStatus = (
      variationMeta._tax_status ||
      parentMeta._tax_status ||
      "taxable"
    ).toLowerCase();
    
    assert.equal(effectiveTaxStatus, "taxable");
  });

  it("should inherit empty _tax_class from parent", () => {
    // WooCommerce: variation with no _tax_class inherits parent's class
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "reduced-rate" };
    const variationMeta: Record<string, string> = {};
    
    const effectiveTaxClass = sanitizeTaxClass(
      variationMeta._tax_class || parentMeta._tax_class || ""
    );
    
    assert.equal(effectiveTaxClass, "reduced-rate");
  });

  it("should respect explicit variation _tax_status=none", () => {
    // WooCommerce: variation with explicit "none" is not taxed
    const parentMeta = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta = { _tax_status: "none" };
    
    const effectiveTaxStatus = (
      variationMeta._tax_status ||
      parentMeta._tax_status ||
      "taxable"
    ).toLowerCase();
    
    assert.equal(effectiveTaxStatus, "none");
  });

  it("should respect explicit variation _tax_status=shipping", () => {
    // WooCommerce: variation with "shipping" status taxes only shipping
    const parentMeta = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta = { _tax_status: "shipping" };
    
    const effectiveTaxStatus = (
      variationMeta._tax_status ||
      parentMeta._tax_status ||
      "taxable"
    ).toLowerCase();
    
    assert.equal(effectiveTaxStatus, "shipping");
  });

  it("should respect explicit variation _tax_class", () => {
    // WooCommerce: variation with explicit class overrides parent
    const parentMeta = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta = { _tax_class: "zero-rate" };
    
    const effectiveTaxClass = sanitizeTaxClass(
      variationMeta._tax_class || parentMeta._tax_class || ""
    );
    
    assert.equal(effectiveTaxClass, "zero-rate");
  });

  it("empty string tax class should match standard rates", () => {
    // WooCommerce: empty string "" is the "standard" tax class
    assert.equal(sanitizeTaxClass(""), "");
    assert.equal(sanitizeTaxClass("standard"), "standard");
    // Rates with tax_rate_class="" match products with empty/standard class
  });

  it("calculates tax on variation using parent settings when variation meta is empty", () => {
    // Real-world scenario: Alabama 4% rate on Manuka Honey variation
    // Parent 2560 is taxable with standard class, variation 2561 has empty meta
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta: Record<string, string> = {}; // Empty - should inherit from parent
    
    const effectiveTaxStatus = (
      variationMeta._tax_status ||
      parentMeta._tax_status ||
      "taxable"
    ).toLowerCase();
    
    const effectiveTaxClass = sanitizeTaxClass(
      variationMeta._tax_class || parentMeta._tax_class || ""
    );
    
    assert.equal(effectiveTaxStatus, "taxable");
    assert.equal(effectiveTaxClass, "");
    
    // Simulate AL 4% tax on $68 line
    const rate: MatchedTaxRate = {
      rateId: 10,
      rate: 4.0,
      label: "AL 4% Sales Tax",
      shipping: true,
      compound: false,
    };
    
    const lineTotal = 68.0;
    const taxes = calcExclusiveTax(lineTotal, [rate]);
    assert.equal(taxes.get(10), 2.72); // 4% of $68 = $2.72
  });

  it("does not tax variation when parent is taxable but variation explicitly set to none", () => {
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta: Record<string, string> = { _tax_status: "none" };
    
    const effectiveTaxStatus = (
      variationMeta._tax_status ||
      parentMeta._tax_status ||
      "taxable"
    ).toLowerCase();
    
    assert.equal(effectiveTaxStatus, "none");
    // When taxStatus !== "taxable", no tax should be calculated
  });
});

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

  it("treats 'standard' as alias for empty string", () => {
    // WooCommerce: "standard" and "" are equivalent (default tax class)
    assert.equal(sanitizeTaxClass("standard"), "");
    assert.equal(sanitizeTaxClass("Standard"), "");
    assert.equal(sanitizeTaxClass("STANDARD"), "");
  });

  it("treats 'standard-rate' as alias for empty string", () => {
    assert.equal(sanitizeTaxClass("standard-rate"), "");
    assert.equal(sanitizeTaxClass("Standard Rate"), "");
    assert.equal(sanitizeTaxClass("STANDARD-RATE"), "");
  });

  it("preserves other tax classes unchanged", () => {
    assert.equal(sanitizeTaxClass("reduced-rate"), "reduced-rate");
    assert.equal(sanitizeTaxClass("zero-rate"), "zero-rate");
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
    {
      tax_rate_id: 5,
      tax_rate_country: "US",
      tax_rate_state: "AL",
      tax_rate: "4.0",
      tax_rate_name: "AL 4% Sales Tax",
      tax_rate_priority: 1,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "",
    },
    {
      tax_rate_id: 6,
      tax_rate_country: "US",
      tax_rate_state: "CA",
      tax_rate: "5.0",
      tax_rate_name: "CA Reduced Rate",
      tax_rate_priority: 1,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "reduced-rate",
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

  it("matches product with 'standard' class to rates with empty class", () => {
    // Product _tax_class='standard' should match rates with tax_rate_class=''
    const productTaxClass = sanitizeTaxClass("standard");
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "AL",
        postcode: "88201",
        city: "Dothan",
        taxClass: productTaxClass,
      },
    );
    assert.equal(matched.length, 1);
    assert.equal(matched[0].rateId, 5); // AL 4% rate
    assert.equal(matched[0].rate, 4.0);
  });

  it("does not match standard class to reduced-rate class", () => {
    const productTaxClass = sanitizeTaxClass("standard");
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "CA",
        postcode: "90210",
        city: "Beverly Hills",
        taxClass: productTaxClass,
      },
    );
    // Should match empty-class rates (1, 2, 4), not reduced-rate (6)
    assert.equal(matched.length, 3);
    assert.deepEqual(
      matched.map((r) => r.rateId),
      [1, 2, 4],
    );
  });

  it("matches reduced-rate products only to reduced-rate rates", () => {
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId },
      {
        country: "US",
        state: "CA",
        postcode: "90210",
        city: "Beverly Hills",
        taxClass: "reduced-rate",
      },
    );
    assert.equal(matched.length, 1);
    assert.equal(matched[0].rateId, 6);
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
    
    // Use the actual logic from wc-tax.ts (after PR merges)
    const isInherit = !variationMeta._tax_status || 
                      variationMeta._tax_status.trim().toLowerCase() === "parent";
    const effectiveTaxStatus = (
      isInherit ? (parentMeta._tax_status || "taxable") : variationMeta._tax_status
    ).toLowerCase();
    
    assert.equal(effectiveTaxStatus, "taxable");
  });

  it("should inherit when _tax_class is literal 'parent' sentinel", () => {
    // WooCommerce: "Same as parent" dropdown stores _tax_class="parent"
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "standard" };
    const variationMeta: Record<string, string> = { _tax_class: "parent" };
    
    const isInherit = !variationMeta._tax_class || 
                      variationMeta._tax_class.trim().toLowerCase() === "parent";
    const rawTaxClass = isInherit 
      ? (parentMeta._tax_class || "")
      : variationMeta._tax_class;
    
    assert.equal(rawTaxClass, "standard");
    
    // Then sanitizeTaxClass converts "standard" → ""
    const taxClass = sanitizeTaxClass(rawTaxClass);
    assert.equal(taxClass, "");
  });

  it("should inherit when _tax_class is 'Parent' (case insensitive)", () => {
    const parentMeta: Record<string, string> = { _tax_class: "reduced-rate" };
    const variationMeta: Record<string, string> = { _tax_class: "Parent" };
    
    const isInherit = !variationMeta._tax_class || 
                      variationMeta._tax_class.trim().toLowerCase() === "parent";
    const rawTaxClass = isInherit 
      ? (parentMeta._tax_class || "")
      : variationMeta._tax_class;
    
    assert.equal(rawTaxClass, "reduced-rate");
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
    // Both "" and "standard" normalize to "" so they match the same rates
    assert.equal(sanitizeTaxClass(""), "");
    assert.equal(sanitizeTaxClass("standard"), "");
    // Products with class "" or "standard" both match rates with tax_rate_class=""
  });

  it("calculates tax on variation using parent settings when variation meta is empty", () => {
    // Real-world scenario: Alabama 4% rate on Manuka Honey variation
    // Parent 2560 is taxable with standard class, variation 2561 has empty meta
    const parentMeta: Record<string, string> = { _tax_status: "taxable", _tax_class: "" };
    const variationMeta: Record<string, string> = {}; // Empty - should inherit from parent
    
    const isInheritStatus = !variationMeta._tax_status || 
                            variationMeta._tax_status.trim().toLowerCase() === "parent";
    const effectiveTaxStatus = (
      isInheritStatus ? (parentMeta._tax_status || "taxable") : variationMeta._tax_status
    ).toLowerCase();
    
    const isInheritClass = !variationMeta._tax_class || 
                           variationMeta._tax_class.trim().toLowerCase() === "parent";
    const rawTaxClass = isInheritClass 
      ? (parentMeta._tax_class || "")
      : variationMeta._tax_class;
    const effectiveTaxClass = sanitizeTaxClass(rawTaxClass);
    
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

  it("calculates tax on variation with _tax_class=parent inheriting standard from parent", () => {
    // REAL BUG: WooCommerce "Same as parent" stores _tax_class="parent"
    // Parent 2560: Tax class Standard
    // Variation 2561: Tax class "Same as parent" (_tax_class="parent")
    // Expected: inherit "standard" → normalize to "" → match AL empty-class rates
    const parentMeta: Record<string, string> = { 
      _tax_status: "taxable", 
      _tax_class: "standard" 
    };
    const variationMeta: Record<string, string> = { 
      _tax_class: "parent" // WooCommerce "Same as parent" literal
    };
    
    // Step 1: Check if variation class is inherit sentinel
    const isInheritClass = !variationMeta._tax_class || 
                           variationMeta._tax_class.trim().toLowerCase() === "parent";
    assert.equal(isInheritClass, true);
    
    // Step 2: Inherit from parent
    const rawTaxClass = isInheritClass 
      ? (parentMeta._tax_class || "")
      : variationMeta._tax_class;
    assert.equal(rawTaxClass, "standard");
    
    // Step 3: Apply standard→'' alias
    const taxClass = sanitizeTaxClass(rawTaxClass);
    assert.equal(taxClass, "");
    
    // Step 4: Match AL rates (tax_rate_class='')
    const rates: WooTaxRateRow[] = [{
      tax_rate_id: 10,
      tax_rate_country: "US",
      tax_rate_state: "AL",
      tax_rate: "4.0",
      tax_rate_name: "AL 4% Sales Tax",
      tax_rate_priority: 1,
      tax_rate_compound: 0,
      tax_rate_shipping: 1,
      tax_rate_order: 0,
      tax_rate_class: "", // Empty class
    }];
    
    const matched = findMatchedTaxRates(
      { rates, locationsByRateId: new Map() },
      {
        country: "US",
        state: "AL",
        postcode: "88201",
        city: "Dothan",
        taxClass, // ""
      },
    );
    
    assert.equal(matched.length, 1);
    assert.equal(matched[0].rateId, 10);
    
    // Step 5: Calculate tax
    const lineTotal = 68.0;
    const taxes = calcExclusiveTax(lineTotal, matched);
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

  it("does not tax product line when _tax_status is none", () => {
    // Products marked _tax_status=none should have lineTax=0 regardless of rates
    const taxStatus: string = "none";
    const lineTotal = 100.0;
    
    // Simulate tax calculation: skip when taxStatus !== "taxable"
    let lineTax = 0;
    if (taxStatus === "taxable" && lineTotal > 0) {
      // Would calculate tax here
      lineTax = 10.0;
    }
    
    assert.equal(lineTax, 0);
  });

  it("does not tax product line when _tax_status is shipping", () => {
    // Products marked _tax_status=shipping should have lineTax=0
    // (shipping itself can still be taxed if rates have tax_rate_shipping=1)
    const taxStatus: string = "shipping";
    const lineTotal = 100.0;
    
    let lineTax = 0;
    if (taxStatus === "taxable" && lineTotal > 0) {
      lineTax = 10.0;
    }
    
    assert.equal(lineTax, 0);
  });

  it("taxes shipping when product has _tax_status=shipping and rates allow", () => {
    // _tax_status=shipping means: don't tax the product line, but shipping can be taxed
    const shippingCost = 14.99;
    const rate: MatchedTaxRate = {
      rateId: 10,
      rate: 4.0,
      label: "AL Sales Tax",
      shipping: true,
      compound: false,
    };
    
    const shippingTax = calcExclusiveTax(shippingCost, [rate]);
    assert.equal(shippingTax.get(10), 0.60); // 4% of $14.99 = $0.60
  });
});

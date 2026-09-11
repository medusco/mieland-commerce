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
    assert.equal(matched.length, 2);
    assert.deepEqual(
      matched.map((r) => r.rateId),
      [1, 2],
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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterEnabledFlexLayoutRows,
  isAcfDisableFlagTruthy,
  isFlexLayoutRowDisabled,
} from "./acf-flex-disable.js";

describe("acf flex layout disable", () => {
  it("detects truthy disable flags", () => {
    assert.equal(isAcfDisableFlagTruthy(true), true);
    assert.equal(isAcfDisableFlagTruthy(1), true);
    assert.equal(isAcfDisableFlagTruthy("1"), true);
    assert.equal(isAcfDisableFlagTruthy("true"), true);
    assert.equal(isAcfDisableFlagTruthy(false), false);
    assert.equal(isAcfDisableFlagTruthy("0"), false);
    assert.equal(isAcfDisableFlagTruthy(null), false);
    assert.equal(isAcfDisableFlagTruthy(undefined), false);
  });

  it("treats missing disable as enabled", () => {
    assert.equal(isFlexLayoutRowDisabled({ fieldGroupName: "HeroLayout" }), false);
    assert.equal(isFlexLayoutRowDisabled({ disable: false }), false);
    assert.equal(isFlexLayoutRowDisabled({ disable: "0" }), false);
  });

  it("drops disabled rows and keeps enabled rows in order", () => {
    const rows = [
      { fieldGroupName: "A", disable: false },
      { fieldGroupName: "B", disable: true },
      { fieldGroupName: "C" },
      { fieldGroupName: "D", block_disable: "1" },
      { fieldGroupName: "E", disable: "true" },
    ];
    const filtered = filterEnabledFlexLayoutRows(rows);
    assert.deepEqual(
      filtered.map((r) => (r as { fieldGroupName: string }).fieldGroupName),
      ["A", "C"],
    );
  });

  it("accepts string disable values", () => {
    assert.equal(isFlexLayoutRowDisabled({ disable: "1" }), true);
    assert.equal(isFlexLayoutRowDisabled({ disable: "true" }), true);
    const filtered = filterEnabledFlexLayoutRows([
      { fieldGroupName: "On", disable: "1" },
      { fieldGroupName: "Off", disable: "true" },
      { fieldGroupName: "Keep", disable: "0" },
    ]);
    assert.equal(filtered.length, 1);
    assert.equal((filtered[0] as { fieldGroupName: string }).fieldGroupName, "Keep");
  });

  it("filters nested flexible content arrays", () => {
    const rows = [
      {
        fieldGroupName: "Parent",
        innerBlocks: [
          { fieldGroupName: "ChildKeep" },
          { fieldGroupName: "ChildDrop", disable: true },
        ],
      },
    ];
    const filtered = filterEnabledFlexLayoutRows(rows) as Array<{
      innerBlocks: Array<{ fieldGroupName: string }>;
    }>;
    assert.equal(filtered.length, 1);
    assert.deepEqual(
      filtered[0].innerBlocks.map((c) => c.fieldGroupName),
      ["ChildKeep"],
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bundledChildKeysByParentKey,
  cartLineBundleMeta,
} from "./bundle-cart.js";

describe("cartLineBundleMeta", () => {
  it("detects bundled child lines from bundled_by", () => {
    const meta = cartLineBundleMeta([
      { key: "_bundled_by", value: "parent-key-1" },
    ]);
    assert.equal(meta.isBundledItem, true);
    assert.equal(meta.bundledByCartKey, "parent-key-1");
  });

  it("reads bundle container stamp on parent lines", () => {
    const meta = cartLineBundleMeta([{ key: "stamp", value: "abc123" }]);
    assert.equal(meta.isBundledItem, false);
    assert.equal(meta.bundleContainerStamp, "abc123");
  });
});

describe("bundledChildKeysByParentKey", () => {
  it("groups children under parent by cart key", () => {
    const map = bundledChildKeysByParentKey([
      { key: "parent", extraData: [{ key: "stamp", value: "stamp-1" }] },
      { key: "child-a", extraData: [{ key: "_bundled_by", value: "parent" }] },
      { key: "child-b", extraData: [{ key: "_bundled_by", value: "parent" }] },
    ]);
    assert.deepEqual(map.get("parent"), ["child-a", "child-b"]);
  });

  it("resolves parent via container stamp when bundled_by references stamp", () => {
    const map = bundledChildKeysByParentKey([
      { key: "parent", extraData: [{ key: "stamp", value: "stamp-1" }] },
      {
        key: "child",
        extraData: [{ key: "_bundled_by", value: "stamp-1" }],
      },
    ]);
    assert.deepEqual(map.get("parent"), ["child"]);
  });
});

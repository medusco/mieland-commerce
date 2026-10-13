import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shapeMenuItems, urlToUri } from "./menus.js";

describe("urlToUri", () => {
  it("strips the site host", () => {
    assert.equal(urlToUri("https://mieland.com/terms/", "https://mieland.com"), "/terms/");
  });
  it("keeps external URLs", () => {
    assert.equal(urlToUri("https://policies.google.com/terms", "https://mieland.com"), "https://policies.google.com/terms");
  });
});

describe("shapeMenuItems", () => {
  it("shapes page and custom items in menu order", () => {
    const rows = [
      { ID: 11, post_title: "", menu_order: 2, meta_key: "_menu_item_type", meta_value: "post_type" },
      { ID: 11, post_title: "", menu_order: 2, meta_key: "_menu_item_object_id", meta_value: "5" },
      { ID: 10, post_title: "Terms of Service", menu_order: 1, meta_key: "_menu_item_type", meta_value: "custom" },
      { ID: 10, post_title: "Terms of Service", menu_order: 1, meta_key: "_menu_item_url", meta_value: "https://mieland.com/terms-of-service/" },
      { ID: 10, post_title: "Terms of Service", menu_order: 1, meta_key: "_menu_item_target", meta_value: "_blank" },
    ];
    const objects = new Map([[5, { ID: 5, post_title: "Privacy Policy", post_name: "privacy-policy", post_type: "page", post_parent: 0 }]]);
    const nodes = shapeMenuItems(rows, objects, "https://mieland.com/", "FOOTER");
    assert.deepEqual(nodes.map((n) => [n.label, n.uri, n.url, n.order, n.target]), [
      ["Terms of Service", "/terms-of-service/", "https://mieland.com/terms-of-service/", 1, "_blank"],
      ["Privacy Policy", "/privacy-policy/", "https://mieland.com/privacy-policy/", 2, null],
    ]);
  });
});

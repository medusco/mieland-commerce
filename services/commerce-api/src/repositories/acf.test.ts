import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acfFlexibleLayoutMetaKey,
  fieldLooksLikeFlexibleContent,
  parseAcfFlexibleContentDisabledIndices,
  shapeAcfField,
  unserializeAcf,
} from "./acf.js";
import { phpUnserialize } from "./options.js";

function phpString(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return `s:${bytes}:"${value}";`;
}

function wrapPhpString(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return `s:${bytes}:"${value}";`;
}

describe("unserializeAcf", () => {
  it("returns empty input unchanged", () => {
    assert.equal(unserializeAcf(""), "");
  });

  it("parses JSON objects", () => {
    assert.deepEqual(unserializeAcf('{"layout":"intro_text"}'), {
      layout: "intro_text",
    });
  });

  it("parses a single PHP-serialized ACF field config", () => {
    const serialized = [
      "a:3:{",
      phpString("type"),
      phpString("text"),
      phpString("parent_layout"),
      phpString("layout_6a6477a257892"),
      phpString("graphql_field_name"),
      phpString("text"),
      "}",
    ].join("");

    assert.deepEqual(unserializeAcf(serialized), {
      type: "text",
      parent_layout: "layout_6a6477a257892",
      graphql_field_name: "text",
    });
  });

  it("unwraps double-serialized PHP strings", () => {
    const inner = phpString("value");
    const wrapped = wrapPhpString(inner);

    assert.equal(unserializeAcf(wrapped), "value");
    assert.equal(phpUnserialize(wrapped), inner);
  });

  it("parses intro text field configs with UTF-8 default_value", () => {
    const defaultValue = "Mieland® — we're rooted in New Zealand.";
    const serialized = [
      "a:4:{",
      phpString("type"),
      phpString("text"),
      phpString("parent_layout"),
      phpString("layout_6a6477a257892"),
      phpString("default_value"),
      phpString(defaultValue),
      phpString("graphql_field_name"),
      phpString("text"),
      "}",
    ].join("");

    const parsed = unserializeAcf(serialized) as Record<string, unknown>;
    assert.equal(parsed.type, "text");
    assert.equal(parsed.parent_layout, "layout_6a6477a257892");
    assert.equal(parsed.default_value, defaultValue);
    assert.equal(parsed.graphql_field_name, "text");
  });
});

describe("ACF 6.5 flexible content layout_meta", () => {
  it("builds layout_meta key from field name", () => {
    assert.equal(acfFlexibleLayoutMetaKey("page_blocks"), "_page_blocks_layout_meta");
    assert.equal(
      acfFlexibleLayoutMetaKey("page_blocks_6_tabs"),
      "_page_blocks_6_tabs_layout_meta",
    );
  });

  it("parses disabled indices from serialized layout_meta", () => {
    const serialized = [
      "a:2:{",
      's:8:"disabled";',
      "a:2:{i:0;i:1;i:1;i:3;}",
      's:7:"renamed";',
      "a:0:{}}",
    ].join("");

    const meta = { _page_blocks_layout_meta: serialized };
    assert.deepEqual(
      [...parseAcfFlexibleContentDisabledIndices(meta, "page_blocks")].sort(),
      [1, 3],
    );
  });

  it("detects flexible content vs repeaters", () => {
    assert.equal(
      fieldLooksLikeFlexibleContent(
        { page_blocks_0_acf_fc_layout: "hero", _page_blocks_layout_meta: "a:0:{}" },
        "page_blocks",
      ),
      true,
    );
    assert.equal(
      fieldLooksLikeFlexibleContent(
        { trust_badges_0_label: "Fast shipping", trust_badges_1_label: "Organic" },
        "trust_badges",
      ),
      false,
    );
  });

  it("omits disabled flexible rows when shaping page_blocks", async () => {
    const layoutMeta = [
      "a:1:{",
      's:8:"disabled";',
      "a:1:{i:0;i:1;}}",
    ].join("");

    const meta: Record<string, string> = {
      page_blocks_0_acf_fc_layout: "hero_banner",
      page_blocks_0_title: "Hero",
      page_blocks_1_acf_fc_layout: "content_tabs",
      page_blocks_1_title: "Tabs (disabled)",
      page_blocks_2_acf_fc_layout: "intro_text",
      page_blocks_2_title: "Intro",
      _page_blocks_layout_meta: layoutMeta,
    };

    const shaped = (await shapeAcfField(meta, "page_blocks")) as Array<
      Record<string, unknown>
    >;
    assert.equal(shaped.length, 2);
    assert.equal(shaped[0].title, "Hero");
    assert.equal(shaped[1].title, "Intro");
  });
});

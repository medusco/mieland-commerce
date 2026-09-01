import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unserializeAcf } from "./acf.js";
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

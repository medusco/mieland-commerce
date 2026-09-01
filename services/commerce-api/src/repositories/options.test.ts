import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maybeUnserializePhp, phpUnserialize } from "./options.js";

function phpString(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return `s:${bytes}:"${value}";`;
}

describe("phpUnserialize", () => {
  it("parses ASCII strings", () => {
    assert.equal(phpUnserialize(phpString("hello")), "hello");
  });

  it("uses UTF-8 byte length for multibyte strings", () => {
    const value = "Mieland®";
    assert.equal(Buffer.byteLength(value, "utf8"), 9);
    assert.equal(value.length, 8);
    assert.equal(phpUnserialize(phpString(value)), value);
  });

  it("parses UTF-8 default_value inside nested ACF field configs", () => {
    const defaultValue =
      "At Mieland®, we are passionate about Manuka honey. We're committed to purity.";
    const serialized = [
      "a:4:{",
      phpString("type"),
      phpString("text"),
      phpString("parent_layout"),
      phpString("layout_6a6477a257892"),
      phpString("graphql_field_name"),
      phpString("text"),
      phpString("default_value"),
      phpString(defaultValue),
      "}",
    ].join("");

    const parsed = phpUnserialize(serialized) as Record<string, unknown>;
    assert.equal(parsed.type, "text");
    assert.equal(parsed.parent_layout, "layout_6a6477a257892");
    assert.equal(parsed.graphql_field_name, "text");
    assert.equal(parsed.default_value, defaultValue);
  });

  it("parses associative arrays and preserves string keys", () => {
    const serialized = `a:2:{${phpString("title")}${phpString("Shop")}${phpString("url")}${phpString("/shop")}}`;
    assert.deepEqual(phpUnserialize(serialized), {
      title: "Shop",
      url: "/shop",
    });
  });

  it("parses integer-keyed arrays as lists", () => {
    const serialized = `a:3:{i:0;${phpString("a")}i:1;${phpString("b")}i:2;${phpString("c")}}`;
    assert.deepEqual(phpUnserialize(serialized), ["a", "b", "c"]);
  });
});

describe("maybeUnserializePhp", () => {
  it("returns JSON objects without PHP parsing", () => {
    assert.deepEqual(maybeUnserializePhp('{"enabled":true}'), { enabled: true });
  });

  it("returns the raw string when PHP parsing fails", () => {
    const invalid = 'a:1:{s:3:"key";s:2:"xyz";}';
    assert.equal(maybeUnserializePhp(invalid), invalid);
  });
});

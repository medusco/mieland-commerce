import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isConcreteOriginEntry,
  isWildcardOriginEntry,
  originMatchesAny,
  originMatchesEntry,
  pickConcreteCorsOrigin,
} from "./origin-match.js";

const VERCEL_PREVIEW = "https://*-mieland-s-projects.vercel.app";
const PREVIEW_ORIGIN =
  "https://mieland-us-git-feature-x-mieland-s-projects.vercel.app";

describe("originMatchesEntry", () => {
  it("matches exact origins", () => {
    assert.equal(
      originMatchesEntry("https://shop.example", "https://shop.example"),
      true,
    );
    assert.equal(
      originMatchesEntry("https://evil.example", "https://shop.example"),
      false,
    );
  });

  it("bare * allows any origin", () => {
    assert.equal(originMatchesEntry("https://evil.example", "*"), true);
    assert.equal(originMatchesEntry("http://localhost:3000", "*"), true);
  });

  it("allows Vercel team preview URLs", () => {
    assert.equal(originMatchesEntry(PREVIEW_ORIGIN, VERCEL_PREVIEW), true);
  });

  it("rejects unrelated hosts", () => {
    assert.equal(
      originMatchesEntry("https://evil.com", VERCEL_PREVIEW),
      false,
    );
  });

  it("rejects suffix attacks that append another domain", () => {
    assert.equal(
      originMatchesEntry(
        "https://x-mieland-s-projects.vercel.app.evil.com",
        VERCEL_PREVIEW,
      ),
      false,
    );
  });

  it("rejects multi-label hosts (* cannot span dots)", () => {
    assert.equal(
      originMatchesEntry(
        "https://a.b-mieland-s-projects.vercel.app",
        VERCEL_PREVIEW,
      ),
      false,
    );
  });

  it("rejects scheme mismatch", () => {
    assert.equal(
      originMatchesEntry(
        "http://mieland-us-git-feature-x-mieland-s-projects.vercel.app",
        VERCEL_PREVIEW,
      ),
      false,
    );
  });

  it("rejects a different hostname suffix", () => {
    assert.equal(
      originMatchesEntry(
        "https://mieland-us-git-feature-x-other-projects.vercel.app",
        VERCEL_PREVIEW,
      ),
      false,
    );
  });

  it("requires port to match when the pattern specifies one", () => {
    assert.equal(
      originMatchesEntry(
        "https://preview-mieland-s-projects.vercel.app:8443",
        "https://*-mieland-s-projects.vercel.app:8443",
      ),
      true,
    );
    assert.equal(
      originMatchesEntry(
        "https://preview-mieland-s-projects.vercel.app",
        "https://*-mieland-s-projects.vercel.app:8443",
      ),
      false,
    );
  });

  it("hostname match is case-insensitive", () => {
    assert.equal(
      originMatchesEntry(
        "https://Preview-Mieland-S-Projects.Vercel.App",
        "https://*-mieland-s-projects.vercel.app",
      ),
      true,
    );
  });
});

describe("originMatchesAny", () => {
  it("matches when any entry allows the origin", () => {
    assert.equal(
      originMatchesAny(PREVIEW_ORIGIN, [
        "https://www.mielandmanuka.com",
        VERCEL_PREVIEW,
      ]),
      true,
    );
    assert.equal(
      originMatchesAny("https://evil.com", [
        "https://www.mielandmanuka.com",
        VERCEL_PREVIEW,
      ]),
      false,
    );
  });
});

describe("concrete / wildcard entry helpers", () => {
  it("classifies wildcard and concrete entries", () => {
    assert.equal(isWildcardOriginEntry(VERCEL_PREVIEW), true);
    assert.equal(isWildcardOriginEntry("*"), false);
    assert.equal(isWildcardOriginEntry("https://shop.example"), false);
    assert.equal(isConcreteOriginEntry("https://shop.example"), true);
    assert.equal(isConcreteOriginEntry("*"), false);
    assert.equal(isConcreteOriginEntry(VERCEL_PREVIEW), false);
  });

  it("pickConcreteCorsOrigin skips * and hostname wildcards", () => {
    assert.equal(
      pickConcreteCorsOrigin(["*", VERCEL_PREVIEW, "https://shop.example"]),
      "https://shop.example",
    );
    assert.equal(pickConcreteCorsOrigin(["*", VERCEL_PREVIEW]), undefined);
  });
});

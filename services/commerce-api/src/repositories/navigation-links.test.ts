import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { navigationLegalLinks, navigationRobotsTxt, parseNavigationLink } from "./navigation-links.js";

const s = (v: string) => `s:${Buffer.byteLength(v, "utf8")}:"${v}";`;
const link = (title: string, url: string, target: string) =>
  `a:3:{${s("title")}${s(title)}${s("url")}${s(url)}${s("target")}${s(target)}}`;

describe("navigation legal links", () => {
  it("parses serialized ACF link options", () => {
    const r = navigationLegalLinks({
      terms_of_service: link("Terms of Service", "https://mielandmanuka.com/pages/terms-conditions", ""),
      privacy_policy: link("Privacy Policy", "https://mielandmanuka.com/pages/privacy-policy", "_blank"),
    });
    assert.deepEqual(r.termsOfService, { title: "Terms of Service", url: "https://mielandmanuka.com/pages/terms-conditions", target: null });
    assert.deepEqual(r.privacyPolicy, { title: "Privacy Policy", url: "https://mielandmanuka.com/pages/privacy-policy", target: "_blank" });
  });
  it("returns null when missing, empty or without url", () => {
    assert.deepEqual(navigationLegalLinks({}), { termsOfService: null, privacyPolicy: null });
    assert.equal(parseNavigationLink(""), null);
    assert.equal(parseNavigationLink(link("x", "", "")), null);
    assert.equal(parseNavigationLink("garbage"), null);
  });
  it("falls back to the mielandNavigationLegalLinks group keys", () => {
    const r = navigationLegalLinks({
      mieland_navigation_legal_links_terms_of_service: link("Terms", "/t", ""),
      privacy_policy: link("Privacy", "/p", ""),
      mieland_navigation_legal_links_privacy_policy: link("Nested", "/nested", ""),
    });
    assert.equal(r.termsOfService?.url, "/t");
    assert.equal(r.privacyPolicy?.url, "/p");
  });
  it("accepts already-parsed objects", () => {
    assert.deepEqual(parseNavigationLink({ title: "T", url: "/t" }), { title: "T", url: "/t", target: null });
  });
});

describe("navigation robots.txt", () => {
  it("returns options_robots_txt, null when empty or whitespace", () => {
    assert.equal(navigationRobotsTxt({ robots_txt: "User-agent: *\nAllow: /" }), "User-agent: *\nAllow: /");
    assert.equal(navigationRobotsTxt({ robots_txt: "  \n " }), null);
    assert.equal(navigationRobotsTxt({}), null);
  });
});
